import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  chmod,
} from 'node:fs/promises';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { FileContentCache } from '../../../src/io/file-content-cache.js';
import { checkTypeWhenMismatch } from '../../../src/core/checks/architecture.js';
import { checkStrictBackwardCoverage } from '../../../src/core/checks/mapping.js';

// ---------------------------------------------------------------------------
// Bounty-2 — exhaustive branch coverage of the file-matching logic in
//   * checkTypeWhenMismatch          (src/core/checks/architecture.ts)
//   * checkStrictBackwardCoverage    (src/core/checks/mapping.ts)
//
// Both are async functions that take (graph, FileContentCache). We build a
// real graph with loadGraph() against a throwaway temp tree (so glob expansion,
// evaluateFileWhen, walkRepoFiles, and mappingEntryMatchesFile all run for
// real), then call the target directly and assert on the returned issues.
//
// Determinism: no random data, no wall-clock reads inside assertions, every
// temp tree removed in a finally. chmod 000 is restored before rm so cleanup
// never leaves an unremovable file (verified: stat succeeds on a 000 file,
// only readFile fails → cache.read reports unreadable, which is the branch we
// want to hit).
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

/** Minimal yg-config with the schema version loadGraph expects. */
const CONFIG = 'version: "5.2.0"\n';

type FileSpec = { rel: string; content: string; mode?: number };
type NodeSpec = { dir: string; yaml: string };

/**
 * Materialize a temp project: write source files, the architecture, the config,
 * and zero or more node yaml files, then loadGraph() it. Returns the loaded
 * graph plus the project root so callers can chmod / inspect.
 */
async function buildProject(opts: {
  files: FileSpec[];
  architecture: string;
  nodes: NodeSpec[];
  gitignore?: string;
  /** Overrides the default `version`-only config, e.g. to add a `coverage:` block. */
  config?: string;
}): Promise<{ root: string; graph: Awaited<ReturnType<typeof loadGraph>> }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-bounty2-'));
  const yggDir = path.join(root, '.yggdrasil');
  await mkdir(path.join(yggDir, 'model'), { recursive: true });
  await writeFile(path.join(yggDir, 'yg-config.yaml'), opts.config ?? CONFIG);
  await writeFile(path.join(yggDir, 'yg-architecture.yaml'), opts.architecture);
  if (opts.gitignore !== undefined) {
    await writeFile(path.join(root, '.gitignore'), opts.gitignore);
  }
  for (const f of opts.files) {
    const abs = path.join(root, f.rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, f.content);
    if (f.mode !== undefined) await chmod(abs, f.mode);
  }
  for (const n of opts.nodes) {
    const ndir = path.join(yggDir, 'model', n.dir);
    await mkdir(ndir, { recursive: true });
    await writeFile(path.join(ndir, 'yg-node.yaml'), n.yaml);
  }
  const graph = await loadGraph(root);
  return { root, graph };
}

/** Restore any chmod-000 files so rm can remove the tree, then remove it. */
async function cleanup(root: string, restore: string[] = []): Promise<void> {
  for (const rel of restore) {
    try {
      await chmod(path.join(root, rel), 0o644);
    } catch {
      /* best effort */
    }
  }
  await rm(root, { recursive: true, force: true });
}

const nodeYaml = (name: string, type: string, mapping: string[]): string =>
  [
    `name: ${name}`,
    `type: ${type}`,
    'description: x',
    ...(mapping.length ? ['mapping:', ...mapping.map((m) => `  - ${m}`)] : []),
    '',
  ].join('\n');

// ===========================================================================
// checkTypeWhenMismatch
// ===========================================================================

describe('checkTypeWhenMismatch — branch coverage', () => {
  it('skips a node whose type is undefined in architecture (typeDef === undefined)', async () => {
    // Node declares type "ghost" not present in node_types → the loop continues
    // past it without ever evaluating when. No type-when-mismatch is produced.
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      content: "@Injectable"',
      ].join('\n'),
      files: [{ rel: 'src/a.ts', content: 'plain code' }],
      nodes: [{ dir: 'ghostnode', yaml: nodeYaml('ghostnode', 'ghost', ['src/a.ts']) }],
    });
    try {
      const { issues, unreadable } = await checkTypeWhenMismatch(graph, new FileContentCache());
      expect(issues.find((i) => i.code === 'type-when-mismatch')).toBeUndefined();
      expect(unreadable).toHaveLength(0);
    } finally {
      await cleanup(root);
    }
  });

  it('skips a node whose type has no when predicate (typeDef.when === undefined)', async () => {
    const { root, graph } = await buildProject({
      architecture: ['node_types:', '  module:', '    description: Organizational'].join('\n'),
      files: [{ rel: 'src/a.ts', content: 'anything' }],
      nodes: [{ dir: 'mod', yaml: nodeYaml('mod', 'module', ['src/a.ts']) }],
    });
    try {
      const { issues } = await checkTypeWhenMismatch(graph, new FileContentCache());
      expect(issues.find((i) => i.code === 'type-when-mismatch')).toBeUndefined();
    } finally {
      await cleanup(root);
    }
  });

  it('treats a node with no mapping as empty (mapping ?? []) — no error', async () => {
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      content: "@Injectable"',
      ].join('\n'),
      files: [],
      // node yaml with no mapping: line at all → node.meta.mapping is undefined
      nodes: [{ dir: 'svc', yaml: nodeYaml('svc', 'service', []) }],
    });
    try {
      const { issues, unreadable } = await checkTypeWhenMismatch(graph, new FileContentCache());
      expect(issues).toHaveLength(0);
      expect(unreadable).toHaveLength(0);
    } finally {
      await cleanup(root);
    }
  });

  it('NON-GLOB entry that does NOT satisfy when → type-when-mismatch (checked as-is)', async () => {
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      content: "@Injectable"',
      ].join('\n'),
      files: [{ rel: 'src/handler.ts', content: 'export function handler() {}' }],
      nodes: [{ dir: 'svc', yaml: nodeYaml('svc', 'service', ['src/handler.ts']) }],
    });
    try {
      const { issues } = await checkTypeWhenMismatch(graph, new FileContentCache());
      const mismatch = issues.find((i) => i.code === 'type-when-mismatch');
      expect(mismatch).toBeDefined();
      expect(mismatch?.nodePath).toBe('svc');
      // The diagnostic names the literal (non-expanded) mapping entry.
      expect(mismatch?.messageData.what).toContain('src/handler.ts');
    } finally {
      await cleanup(root);
    }
  });

  it('NON-GLOB entry that DOES satisfy when → no error (!result.result is false)', async () => {
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      content: "@Injectable"',
      ].join('\n'),
      files: [{ rel: 'src/handler.ts', content: '@Injectable()\nexport class S {}' }],
      nodes: [{ dir: 'svc', yaml: nodeYaml('svc', 'service', ['src/handler.ts']) }],
    });
    try {
      const { issues } = await checkTypeWhenMismatch(graph, new FileContentCache());
      expect(issues.find((i) => i.code === 'type-when-mismatch')).toBeUndefined();
    } finally {
      await cleanup(root);
    }
  });

  it('GLOB entry expands; a matched file that fails when → type-when-mismatch on the matched file (not the glob string)', async () => {
    // when requires .ts extension via path; glob is extension-less so it also
    // matches a .js file that does NOT satisfy when. The error must name the
    // expanded file path, not the literal glob.
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      path: "src/svc/**/*.ts"',
      ].join('\n'),
      files: [
        { rel: 'src/svc/ok.ts', content: 'export const ok = 1;' },
        { rel: 'src/svc/bad.js', content: 'module.exports = {};' },
      ],
      nodes: [{ dir: 'svc', yaml: nodeYaml('svc', 'service', ['src/svc/*']) }],
    });
    try {
      const { issues } = await checkTypeWhenMismatch(graph, new FileContentCache());
      const mismatches = issues.filter((i) => i.code === 'type-when-mismatch');
      // Only bad.js mismatches; ok.ts satisfies the .ts when.
      expect(mismatches).toHaveLength(1);
      // The diagnostic names the expanded matched file as its subject ("File
      // 'src/svc/bad.js' is in mapping ..."), proving the glob was expanded to
      // its matched files rather than checked as the literal pattern string.
      expect(mismatches[0].messageData.what).toContain("File 'src/svc/bad.js'");
    } finally {
      await cleanup(root);
    }
  });

  it('GLOB entry whose every matched file satisfies when → no error', async () => {
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      path: "src/svc/**/*.ts"',
      ].join('\n'),
      files: [
        { rel: 'src/svc/a.ts', content: 'export const a = 1;' },
        { rel: 'src/svc/b.ts', content: 'export const b = 2;' },
      ],
      nodes: [{ dir: 'svc', yaml: nodeYaml('svc', 'service', ['src/svc/*.ts']) }],
    });
    try {
      const { issues } = await checkTypeWhenMismatch(graph, new FileContentCache());
      expect(issues.find((i) => i.code === 'type-when-mismatch')).toBeUndefined();
    } finally {
      await cleanup(root);
    }
  });

  it('GLOB entry matching NO files → no paths to check, no error', async () => {
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      content: "@Injectable"',
      ].join('\n'),
      files: [{ rel: 'src/real.ts', content: 'plain' }],
      // glob points at a dir with no matching files → expandMappingPaths yields []
      nodes: [{ dir: 'svc', yaml: nodeYaml('svc', 'service', ['src/nope/*.ts']) }],
    });
    try {
      const { issues, unreadable } = await checkTypeWhenMismatch(graph, new FileContentCache());
      expect(issues.find((i) => i.code === 'type-when-mismatch')).toBeUndefined();
      expect(unreadable).toHaveLength(0);
    } finally {
      await cleanup(root);
    }
  });

  it('UNREADABLE file with a content predicate → file-unreadable (not type-when-mismatch)', async () => {
    // chmod 000 → readFile EACCES → cache.read reports unreadable → the
    // result.unreadable branch fires, pushing to `unreadable` and continuing.
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      content: "@Injectable"',
      ].join('\n'),
      files: [{ rel: 'src/locked.ts', content: '@Injectable secret', mode: 0o000 }],
      nodes: [{ dir: 'svc', yaml: nodeYaml('svc', 'service', ['src/locked.ts']) }],
    });
    try {
      const { issues, unreadable } = await checkTypeWhenMismatch(graph, new FileContentCache());
      expect(unreadable.find((i) => i.code === 'file-unreadable')).toBeDefined();
      expect(unreadable[0].messageData.what).toContain('src/locked.ts');
      // The unreadable file must NOT also produce a type-when-mismatch.
      expect(issues.find((i) => i.code === 'type-when-mismatch')).toBeUndefined();
    } finally {
      await cleanup(root, ['src/locked.ts']);
    }
  });

  it('mapping pointing under .yggdrasil/ is auto-exempt (when returns vacuously true) → no error', async () => {
    // evaluateFileWhen returns result:true for any .yggdrasil/ path BEFORE
    // touching content, so even a content predicate cannot fail here.
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      content: "@Injectable"',
      ].join('\n'),
      files: [{ rel: '.yggdrasil/notes.md', content: 'no injectable here' }],
      nodes: [{ dir: 'svc', yaml: nodeYaml('svc', 'service', ['.yggdrasil/notes.md']) }],
    });
    try {
      const { issues, unreadable } = await checkTypeWhenMismatch(graph, new FileContentCache());
      expect(issues.find((i) => i.code === 'type-when-mismatch')).toBeUndefined();
      expect(unreadable).toHaveLength(0);
    } finally {
      await cleanup(root);
    }
  });

  it('CHILD-PRECEDENCE carve-out: a file a descendant node claims is not checked against the ancestor type', async () => {
    // Parent node `data` (type repository, glob-maps src/data/**) would classify
    // every file under src/data against the repository when. Child node
    // `data/svc` (type service) carves out src/data/UserService.ts — that file
    // legitimately belongs to the child and satisfies the service when, not the
    // repository when. Before the child-precedence carve-out, the ancestor's
    // type-when check folded that file in and raised a false type-when-mismatch.
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  repository:',
        '    description: Repository',
        '    when:',
        '      content: "extends Repository"',
        '  service:',
        '    description: Service',
        '    parents: [repository]',
        '    when:',
        '      content: "class .*Service"',
      ].join('\n'),
      files: [
        { rel: 'src/data/UserRepo.ts', content: 'class UserRepo extends Repository {}' },
        { rel: 'src/data/UserService.ts', content: 'class UserService {}' },
      ],
      nodes: [
        { dir: 'data', yaml: nodeYaml('data', 'repository', ['src/data/**/*.ts']) },
        { dir: 'data/svc', yaml: nodeYaml('svc', 'service', ['src/data/UserService.ts']) },
      ],
    });
    try {
      const { issues, unreadable } = await checkTypeWhenMismatch(graph, new FileContentCache());
      // The child-owned file must NOT be reported against the parent type.
      expect(
        issues.find(
          (i) =>
            i.code === 'type-when-mismatch' &&
            i.messageData.what.includes('src/data/UserService.ts'),
        ),
      ).toBeUndefined();
      // And nothing at all should fire: the parent's own file satisfies its when,
      // the child's own file satisfies the service when.
      expect(issues.find((i) => i.code === 'type-when-mismatch')).toBeUndefined();
      expect(unreadable).toHaveLength(0);
    } finally {
      await cleanup(root);
    }
  });

  it('NEGATIVE CONTROL: without a descendant claiming it, a non-satisfying file in the parent mapping still fires', async () => {
    // Same shape as the carve-out case but with NO child node — the file stays
    // owned by the parent, so the repository when is (correctly) enforced and a
    // type-when-mismatch is raised. Proves the carve-out only removes files a
    // descendant genuinely claims, not the parent's own non-satisfying files.
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  repository:',
        '    description: Repository',
        '    when:',
        '      content: "extends Repository"',
      ].join('\n'),
      files: [
        { rel: 'src/data/UserRepo.ts', content: 'class UserRepo extends Repository {}' },
        { rel: 'src/data/UserService.ts', content: 'class UserService {}' },
      ],
      nodes: [{ dir: 'data', yaml: nodeYaml('data', 'repository', ['src/data/**/*.ts']) }],
    });
    try {
      const { issues } = await checkTypeWhenMismatch(graph, new FileContentCache());
      const mismatch = issues.find(
        (i) =>
          i.code === 'type-when-mismatch' &&
          i.messageData.what.includes('src/data/UserService.ts'),
      );
      expect(mismatch).toBeDefined();
      expect(mismatch?.nodePath).toBe('data');
    } finally {
      await cleanup(root);
    }
  });
});

// ===========================================================================
// checkStrictBackwardCoverage
// ===========================================================================

describe('checkStrictBackwardCoverage — branch coverage', () => {
  const STRICT_ARCH = [
    'node_types:',
    '  command:',
    '    description: Command',
    '    enforce: strict',
    '    when:',
    '      content: "registerCommand"',
  ].join('\n');

  it('no strict types → returns empty (early return), even with matching-looking files', async () => {
    // enforce: strict is absent → strictTypes filtered to []. A type with a
    // when but no enforce:strict must NOT be scanned backward.
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      content: "registerCommand"',
      ].join('\n'),
      files: [{ rel: 'src/cmd.ts', content: 'registerCommand("x")' }],
      nodes: [],
    });
    try {
      const { issues, unreadable } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      expect(issues).toHaveLength(0);
      expect(unreadable).toHaveLength(0);
    } finally {
      await cleanup(root);
    }
  });

  it('strict type WITHOUT when is filtered out (def.when !== undefined guard) → empty', async () => {
    // enforce: strict but no when → filtered out of strictTypes → early empty.
    // (The separate enforce-strict-without-when check flags this elsewhere.)
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  command:',
        '    description: Command',
        '    enforce: strict',
      ].join('\n'),
      files: [{ rel: 'src/cmd.ts', content: 'registerCommand("x")' }],
      nodes: [],
    });
    try {
      const { issues, unreadable } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      expect(issues).toHaveLength(0);
      expect(unreadable).toHaveLength(0);
    } finally {
      await cleanup(root);
    }
  });

  it('matching file in NO mapping → type-strict-orphan (owner === undefined)', async () => {
    const { root, graph } = await buildProject({
      architecture: STRICT_ARCH,
      files: [{ rel: 'src/cmd.ts', content: 'registerCommand("foo")' }],
      nodes: [], // file exists on disk, owned by no node
    });
    try {
      const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      const orphan = issues.find((i) => i.code === 'type-strict-orphan');
      expect(orphan).toBeDefined();
      expect(orphan?.messageData.what).toContain('src/cmd.ts');
      expect(orphan?.messageData.what).toContain('command');
    } finally {
      await cleanup(root);
    }
  });

  it('matching file owned via a PLAIN mapping entry of the right type → no error (owner.nodeType === typeId)', async () => {
    const { root, graph } = await buildProject({
      architecture: STRICT_ARCH,
      files: [{ rel: 'src/cmd.ts', content: 'registerCommand("foo")' }],
      nodes: [{ dir: 'cmd', yaml: nodeYaml('cmd', 'command', ['src/cmd.ts']) }],
    });
    try {
      const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      expect(issues.find((i) => i.code === 'type-strict-orphan')).toBeUndefined();
      expect(issues.find((i) => i.code === 'type-strict-misplaced')).toBeUndefined();
    } finally {
      await cleanup(root);
    }
  });

  it('matching file owned via a GLOB mapping entry of the right type → no error (glob owner resolution)', async () => {
    // Exercises mappingEntryMatchesFile's glob branch during owner resolution.
    const { root, graph } = await buildProject({
      architecture: STRICT_ARCH,
      files: [{ rel: 'src/cmd.ts', content: 'registerCommand("foo")' }],
      nodes: [{ dir: 'cmd', yaml: nodeYaml('cmd', 'command', ['src/*.ts']) }],
    });
    try {
      const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      expect(issues.find((i) => i.code === 'type-strict-orphan')).toBeUndefined();
      expect(issues.find((i) => i.code === 'type-strict-misplaced')).toBeUndefined();
    } finally {
      await cleanup(root);
    }
  });

  it('matching file owned by a WRONG-type node (plain entry) → type-strict-misplaced (owner.nodeType !== typeId)', async () => {
    const { root, graph } = await buildProject({
      architecture: [
        STRICT_ARCH,
        '  utility:',
        '    description: Utility',
        '    when:',
        '      path: "**"',
      ].join('\n'),
      files: [{ rel: 'src/cmd.ts', content: 'registerCommand("foo")' }],
      nodes: [{ dir: 'util', yaml: nodeYaml('util', 'utility', ['src/cmd.ts']) }],
    });
    try {
      const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      const misplaced = issues.find((i) => i.code === 'type-strict-misplaced');
      expect(misplaced).toBeDefined();
      expect(misplaced?.nodePath).toBe('util');
      expect(misplaced?.messageData.what).toContain('src/cmd.ts');
    } finally {
      await cleanup(root);
    }
  });

  it('matching file owned by a WRONG-type node via a GLOB entry → type-strict-misplaced', async () => {
    const { root, graph } = await buildProject({
      architecture: [
        STRICT_ARCH,
        '  utility:',
        '    description: Utility',
        '    when:',
        '      path: "**"',
      ].join('\n'),
      files: [{ rel: 'src/cmd.ts', content: 'registerCommand("foo")' }],
      nodes: [{ dir: 'util', yaml: nodeYaml('util', 'utility', ['src/*.ts']) }],
    });
    try {
      const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      const misplaced = issues.find((i) => i.code === 'type-strict-misplaced');
      expect(misplaced).toBeDefined();
      expect(misplaced?.nodePath).toBe('util');
    } finally {
      await cleanup(root);
    }
  });

  it('CHILD-PRECEDENCE: a descendant node of the RIGHT type owns the file inside a parent glob → no misplaced (false-refuse guard)', async () => {
    // Parent node (non-strict utility) globs the directory; a nested child node
    // of the strict `command` type claims the specific file. Under child-precedence
    // the child owns the file, so the strict rule is satisfied. The old first-match
    // (insertion-order) owner loop resolved the ANCESTOR (utility) first and falsely
    // raised type-strict-misplaced against a correct, supported layout.
    const { root, graph } = await buildProject({
      architecture: [
        STRICT_ARCH,
        '  utility:',
        '    description: Utility',
        '    when:',
        '      path: "**"',
      ].join('\n'),
      files: [{ rel: 'src/cmd.ts', content: 'registerCommand("foo")' }],
      nodes: [
        { dir: 'feature', yaml: nodeYaml('feature', 'utility', ['src/*.ts']) },
        { dir: 'feature/cmd', yaml: nodeYaml('feature/cmd', 'command', ['src/cmd.ts']) },
      ],
    });
    try {
      const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      expect(issues.find((i) => i.code === 'type-strict-misplaced')).toBeUndefined();
      expect(issues.find((i) => i.code === 'type-strict-orphan')).toBeUndefined();
    } finally {
      await cleanup(root);
    }
  });

  it('CHILD-PRECEDENCE: a descendant node of the WRONG type owns the file inside a parent glob → misplaced names the CHILD (false-pass guard)', async () => {
    // Parent node is the strict `command` type and globs the directory; a nested
    // child of a different type claims the specific file. The child is the real
    // runtime owner, so its type governs — the strict rule is violated and the
    // error must name the CHILD. The old first-match loop resolved the ancestor
    // (command) first, matched the strict type, and silently PASSED over a file
    // whose real owner has the wrong type (a green build that lies).
    const { root, graph } = await buildProject({
      architecture: [
        STRICT_ARCH,
        '  utility:',
        '    description: Utility',
        '    when:',
        '      path: "**"',
      ].join('\n'),
      files: [{ rel: 'src/cmd.ts', content: 'registerCommand("foo")' }],
      nodes: [
        { dir: 'feature', yaml: nodeYaml('feature', 'command', ['src/*.ts']) },
        { dir: 'feature/cmd', yaml: nodeYaml('feature/cmd', 'utility', ['src/cmd.ts']) },
      ],
    });
    try {
      const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      const misplaced = issues.find((i) => i.code === 'type-strict-misplaced');
      expect(misplaced).toBeDefined();
      expect(misplaced?.nodePath).toBe('feature/cmd');
    } finally {
      await cleanup(root);
    }
  });

  it('file matching NO strict type → continue, no error (matchingTypes.length === 0)', async () => {
    const { root, graph } = await buildProject({
      architecture: STRICT_ARCH,
      files: [{ rel: 'src/plain.ts', content: 'export const x = 1;' }],
      nodes: [],
    });
    try {
      const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      expect(issues).toHaveLength(0);
    } finally {
      await cleanup(root);
    }
  });

  it('file matching TWO strict types → strict-overlap-conflict (matchingTypes.length > 1), superseding orphan', async () => {
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  alpha:',
        '    description: Alpha',
        '    enforce: strict',
        '    when:',
        '      path: "**"',
        '  beta:',
        '    description: Beta',
        '    enforce: strict',
        '    when:',
        '      path: "**"',
      ].join('\n'),
      files: [{ rel: 'src/any.ts', content: 'anything' }],
      nodes: [],
    });
    try {
      const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      const conflict = issues.find((i) => i.code === 'strict-overlap-conflict');
      expect(conflict).toBeDefined();
      // alpha/beta sorted; both type names appear.
      expect(conflict?.messageData.what).toContain('alpha');
      expect(conflict?.messageData.what).toContain('beta');
      // Conflict supersedes orphan/misplaced for that file.
      expect(issues.find((i) => i.code === 'type-strict-orphan')).toBeUndefined();
      expect(issues.find((i) => i.code === 'type-strict-misplaced')).toBeUndefined();
    } finally {
      await cleanup(root);
    }
  });

  it('overlap dedup: two files matching the SAME strict pair → exactly one conflict (overlapPairsSeen)', async () => {
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  alpha:',
        '    description: Alpha',
        '    enforce: strict',
        '    when:',
        '      path: "**"',
        '  beta:',
        '    description: Beta',
        '    enforce: strict',
        '    when:',
        '      path: "**"',
      ].join('\n'),
      files: [
        { rel: 'src/a.ts', content: 'a' },
        { rel: 'src/b.ts', content: 'b' },
      ],
      nodes: [],
    });
    try {
      const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      const conflicts = issues.filter((i) => i.code === 'strict-overlap-conflict');
      expect(conflicts).toHaveLength(1);
    } finally {
      await cleanup(root);
    }
  });

  it('three strict types all matching one file → N-choose-2 = 3 conflict pairs', async () => {
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  t0:',
        '    description: t0',
        '    enforce: strict',
        '    when:',
        '      path: "**"',
        '  t1:',
        '    description: t1',
        '    enforce: strict',
        '    when:',
        '      path: "**"',
        '  t2:',
        '    description: t2',
        '    enforce: strict',
        '    when:',
        '      path: "**"',
      ].join('\n'),
      files: [{ rel: 'src/any.ts', content: 'x' }],
      nodes: [],
    });
    try {
      const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      const conflicts = issues.filter((i) => i.code === 'strict-overlap-conflict');
      expect(conflicts).toHaveLength(3);
    } finally {
      await cleanup(root);
    }
  });

  it('UNREADABLE file during strict scan → file-unreadable, fileSkipped break (no orphan/misplaced)', async () => {
    // The strict type uses a content predicate; the only repo file is chmod 000
    // → cache.read unreadable → result.unreadable branch → push file-unreadable,
    // set fileSkipped, break, and `continue` past orphan/misplaced logic.
    const { root, graph } = await buildProject({
      architecture: STRICT_ARCH,
      files: [{ rel: 'src/locked.ts', content: 'registerCommand("x")', mode: 0o000 }],
      nodes: [],
    });
    try {
      const { issues, unreadable } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      expect(unreadable.find((i) => i.code === 'file-unreadable')).toBeDefined();
      expect(unreadable[0].messageData.what).toContain('src/locked.ts');
      expect(unreadable[0].messageData.what).toContain('strict backward scan');
      // No classification verdict for a file we could not read.
      expect(issues.find((i) => i.code === 'type-strict-orphan')).toBeUndefined();
      expect(issues.find((i) => i.code === 'type-strict-misplaced')).toBeUndefined();
    } finally {
      await cleanup(root, ['src/locked.ts']);
    }
  });

  it('gitignored matching file is skipped by walkRepoFiles → no orphan reported', async () => {
    // The strict scan only sees walkRepoFiles output; a gitignored file is not
    // walked, so it cannot become an orphan even though it matches the when.
    const { root, graph } = await buildProject({
      architecture: STRICT_ARCH,
      files: [{ rel: 'src/cmd.ts', content: 'registerCommand("foo")' }],
      nodes: [],
      gitignore: 'src/cmd.ts\n',
    });
    try {
      const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      expect(issues.find((i) => i.code === 'type-strict-orphan')).toBeUndefined();
    } finally {
      await cleanup(root);
    }
  });

  it('an unmapped file under coverage.excluded satisfies a strict when but raises no orphan — exclusion is invisible to the strict scan too', async () => {
    // Same shape as the plain orphan case above (a strict-typed, unmapped file
    // on disk), but the file's directory is excluded. Every other type-level
    // question (classification, ambiguous-node-type) already skips an excluded
    // file before ever reaching a verdict; this pins that the strict backward
    // scan now agrees instead of being the one holdout that still names it.
    const { root, graph } = await buildProject({
      architecture: STRICT_ARCH,
      files: [{ rel: 'secrets/cmd.ts', content: 'registerCommand("foo")' }],
      nodes: [],
      config: 'version: "5.2.0"\ncoverage:\n  excluded:\n    - secrets/\n',
    });
    try {
      const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      expect(issues.find((i) => i.code === 'type-strict-orphan')).toBeUndefined();
      expect(issues).toHaveLength(0);
    } finally {
      await cleanup(root);
    }
  });

  it('control: the identical file OUTSIDE the excluded root still raises the orphan — the exclusion did not silence strict scanning generally', async () => {
    const { root, graph } = await buildProject({
      architecture: STRICT_ARCH,
      files: [{ rel: 'secrets/cmd.ts', content: 'registerCommand("foo")' }],
      nodes: [],
      config: 'version: "5.2.0"\ncoverage:\n  excluded:\n    - unrelated/\n',
    });
    try {
      const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      const orphan = issues.find((i) => i.code === 'type-strict-orphan');
      expect(orphan).toBeDefined();
      expect(orphan?.messageData.what).toContain('secrets/cmd.ts');
    } finally {
      await cleanup(root);
    }
  });

  // The node's type is 'other', NOT 'command' — the strict type itself — so the
  // file (mapped, satisfying command's when) would be MISPLACED (owner type !==
  // matched type) if the exclusion did not remove it from the scan's candidate
  // set first. Mapping it to 'command' (the strict type) would make neither
  // orphan nor misplaced possible to fire regardless of exclusion, proving
  // nothing about the exclusion filter at all.
  const STRICT_ARCH_WITH_OTHER = `${STRICT_ARCH}\n  other:\n    description: Not a command\n`;

  it('a MAPPED file under coverage.excluded raises no orphan/misplaced either — exclusion removes it from the strict scan\'s candidate set entirely, not just from ownership resolution', async () => {
    const { root, graph } = await buildProject({
      architecture: STRICT_ARCH_WITH_OTHER,
      files: [{ rel: 'secrets/cmd.ts', content: 'registerCommand("foo")' }],
      nodes: [{ dir: 'holder', yaml: nodeYaml('holder', 'other', ['secrets/cmd.ts']) }],
      config: 'version: "5.2.0"\ncoverage:\n  excluded:\n    - secrets/\n',
    });
    try {
      const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      expect(issues.find((i) => i.code === 'type-strict-orphan')).toBeUndefined();
      expect(issues.find((i) => i.code === 'type-strict-misplaced')).toBeUndefined();
    } finally {
      await cleanup(root);
    }
  });

  it('control: the identical mapped-to-the-wrong-type file OUTSIDE the excluded root still raises type-strict-misplaced', async () => {
    const { root, graph } = await buildProject({
      architecture: STRICT_ARCH_WITH_OTHER,
      files: [{ rel: 'secrets/cmd.ts', content: 'registerCommand("foo")' }],
      nodes: [{ dir: 'holder', yaml: nodeYaml('holder', 'other', ['secrets/cmd.ts']) }],
      config: 'version: "5.2.0"\ncoverage:\n  excluded:\n    - unrelated/\n',
    });
    try {
      const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      const misplaced = issues.find((i) => i.code === 'type-strict-misplaced');
      expect(misplaced).toBeDefined();
      expect(misplaced?.nodePath).toBe('holder');
      expect(misplaced?.messageData.what).toContain('secrets/cmd.ts');
    } finally {
      await cleanup(root);
    }
  });
});

// ===========================================================================
// E2E — confirm the same logic is reachable through the spawned `yg` binary.
// Mirrors tests/e2e/cli-architecture-when-validation.test.ts: copy the
// committed e2e-lifecycle fixture into a temp dir, mutate it, run `yg check`,
// and assert on exit code + the architecture code in stdout. The fixture
// carries unrelated drift/unapproved noise, so we assert on presence/absence
// of the specific code rather than full isolation.
// ===========================================================================

const archPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
const ordersNodePath = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-bounty2-e2e-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function run(args: string[], cwd: string): { stdout: string; status: number | null; all: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { stdout, status: r.status, all: stdout + stderr };
}

describe.skipIf(!distExists)('E2E — type-when + strict-backward via yg check', () => {
  it('E1 (checkTypeWhenMismatch): a glob mapping whose matched file fails when raises type-when-mismatch (exit 1)', () => {
    const dir = copyFixture('when-mismatch');
    try {
      // Require a .ts extension for service files; orders owns its file via an
      // extension-less glob. Add a sibling .js file that the glob also matches
      // but the .ts when rejects → mismatch on the matched file.
      const arch = readFileSync(archPath(dir), 'utf-8').replace(
        '    when:\n      path: "src/services/**"',
        '    when:\n      path: "src/services/**/*.ts"',
      );
      writeFileSync(archPath(dir), arch, 'utf-8');
      writeFileSync(path.join(dir, 'src', 'services', 'legacy.js'), 'module.exports = {};', 'utf-8');
      const y = readFileSync(ordersNodePath(dir), 'utf-8').replace(
        'src/services/orders.ts',
        'src/services/*',
      );
      writeFileSync(ordersNodePath(dir), y, 'utf-8');

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('type-when-mismatch');
      expect(stdout).toContain('src/services/legacy.js');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E2 (checkStrictBackwardCoverage): a strict type with an orphan matching file raises type-strict-orphan (exit 1)', () => {
    const dir = copyFixture('strict-orphan');
    try {
      // Make `service` enforce: strict and match a marker, then drop an
      // unmapped file carrying that marker under src/ — a backward orphan.
      const arch = readFileSync(archPath(dir), 'utf-8').replace(
        "    when:\n      path: \"src/services/**\"",
        '    enforce: strict\n    when:\n      content: "STRICT_MARKER"',
      );
      writeFileSync(archPath(dir), arch, 'utf-8');
      // Existing mapped files (orders.ts/payments.ts) must NOT carry the marker
      // or they would themselves become misplaced/orphan and add noise; the new
      // file is the sole match.
      writeFileSync(path.join(dir, 'src', 'loose.ts'), '// STRICT_MARKER\nexport const x = 1;', 'utf-8');

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('type-strict-orphan');
      expect(stdout).toContain('src/loose.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E3 (checkStrictBackwardCoverage): two strict types matching the same file raise strict-overlap-conflict (exit 1)', () => {
    const dir = copyFixture('strict-overlap');
    try {
      const arch = readFileSync(archPath(dir), 'utf-8').replace(
        '    when:\n      path: "src/services/**"',
        '    enforce: strict\n    when:\n      path: "src/services/**"',
      );
      // Append a second strict type whose when also matches everything under src.
      const withSecond =
        arch +
        [
          '',
          '  shadow:',
          "    description: 'second strict type that overlaps service'",
          '    enforce: strict',
          '    when:',
          '      path: "src/**"',
          '',
        ].join('\n');
      writeFileSync(archPath(dir), withSecond, 'utf-8');

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('strict-overlap-conflict');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
