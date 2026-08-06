import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runGitFixture } from '../../support/git-fixture.js';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { validate } from '../../../src/core/validator.js';
import { runCheck } from '../../../src/core/check.js';
import { evaluateFileWhen } from '../../../src/core/file-when-evaluator.js';
import { FileContentCache } from '../../../src/io/file-content-cache.js';
import {
  checkTypeWithoutWhenWithMapping,
  checkTypeWhenMismatch,
  checkEnforceStrictWithoutWhen,
  checkArchitectureParents,
} from '../../../src/core/checks/architecture.js';
import { checkStrictBackwardCoverage } from '../../../src/core/checks/mapping.js';
import type { FileWhenPredicate } from '../../../src/model/file-when.js';

// ---------------------------------------------------------------------------
// Bounty-4 — SPEC-CONFORMANCE audit of the documentation topic
//   `yg knowledge read working-with-architecture`
// against the implementing code:
//   * src/core/checks/architecture.ts
//   * src/core/file-when-evaluator.ts
//   (+ the strict-backward enforcement in src/core/checks/mapping.ts, which the
//    doc attributes to the architecture topic via type-strict-orphan /
//    type-strict-misplaced)
//
// Each test maps to a CONCRETE, TESTABLE invariant quoted from the doc. Where
// behavior is CLI-observable we drive the spawned dist/bin.js against a hermetic
// temp repo. Otherwise we call the real check/evaluator functions against a
// graph loaded from a throwaway temp tree (loadGraph), so glob expansion,
// evaluateFileWhen, and walkRepoFiles all run for real.
//
// Determinism: no random data, no wall-clock reads in assertions, every temp
// tree removed in a finally.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

const CONFIG = 'version: "5.2.0"\n';

type FileSpec = { rel: string; content: string };
type NodeSpec = { dir: string; yaml: string };

async function buildProject(opts: {
  files: FileSpec[];
  architecture: string;
  nodes: NodeSpec[];
  gitignore?: string;
}): Promise<{ root: string; graph: Awaited<ReturnType<typeof loadGraph>> }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-bounty4-'));
  const yggDir = path.join(root, '.yggdrasil');
  await mkdir(path.join(yggDir, 'model'), { recursive: true });
  await writeFile(path.join(yggDir, 'yg-config.yaml'), CONFIG);
  await writeFile(path.join(yggDir, 'yg-architecture.yaml'), opts.architecture);
  if (opts.gitignore !== undefined) {
    await writeFile(path.join(root, '.gitignore'), opts.gitignore);
  }
  for (const f of opts.files) {
    const abs = path.join(root, f.rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, f.content);
  }
  for (const n of opts.nodes) {
    const ndir = path.join(yggDir, 'model', n.dir);
    await mkdir(ndir, { recursive: true });
    await writeFile(path.join(ndir, 'yg-node.yaml'), n.yaml);
  }
  const graph = await loadGraph(root);
  return { root, graph };
}

const nodeYaml = (name: string, type: string, mapping: string[], extra: string[] = []): string =>
  [
    `name: ${name}`,
    `type: ${type}`,
    'description: x',
    ...extra,
    ...(mapping.length ? ['mapping:', ...mapping.map((m) => `  - ${m}`)] : []),
    '',
  ].join('\n');

function ctxFor(root: string, rel: string, cache: FileContentCache) {
  return {
    absPath: path.join(root, rel),
    repoRelPath: rel,
    projectRoot: root,
    cache,
  };
}

// ===========================================================================
// INVARIANT GROUP 1 — Type kinds (classifying vs organizational)
//   Doc: "Classifying types — have `when`."
//        "Organizational types — no `when`. Used as parent-only ... Nodes of
//         this type cannot have non-empty `mapping:`."
// ===========================================================================

describe('Type kinds: organizational (no when) cannot map files', () => {
  it('organizational type with a non-empty mapping → type-without-when-with-mapping', async () => {
    const { root, graph } = await buildProject({
      architecture: ['node_types:', '  module:', '    description: Organizational grouping'].join('\n'),
      files: [{ rel: 'src/a.ts', content: 'export const a = 1;' }],
      nodes: [{ dir: 'mod', yaml: nodeYaml('mod', 'module', ['src/a.ts']) }],
    });
    try {
      const issues = checkTypeWithoutWhenWithMapping(graph);
      const issue = issues.find((i) => i.code === 'type-without-when-with-mapping');
      expect(issue).toBeDefined();
      expect(issue?.nodePath).toBe('mod');
      // Doc justification phrasing: organizational/parent-only.
      expect(issue?.messageData.why).toMatch(/organizational/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('organizational type with an EMPTY mapping is allowed (parent-only usage)', async () => {
    const { root, graph } = await buildProject({
      architecture: ['node_types:', '  module:', '    description: Organizational grouping'].join('\n'),
      files: [],
      nodes: [{ dir: 'mod', yaml: nodeYaml('mod', 'module', []) }],
    });
    try {
      const issues = checkTypeWithoutWhenWithMapping(graph);
      expect(issues.find((i) => i.code === 'type-without-when-with-mapping')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('classifying type (has when) MAY carry a mapping (no organizational restriction)', async () => {
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      path: "**"',
      ].join('\n'),
      files: [{ rel: 'src/a.ts', content: 'x' }],
      nodes: [{ dir: 'svc', yaml: nodeYaml('svc', 'service', ['src/a.ts']) }],
    });
    try {
      const issues = checkTypeWithoutWhenWithMapping(graph);
      expect(issues.find((i) => i.code === 'type-without-when-with-mapping')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// INVARIANT GROUP 2 — Forward classification (type-when-mismatch)
//   Doc: "Files in mappings of nodes of this type must satisfy `when`
//         (forward)."
// ===========================================================================

describe('Forward classification: mapped files must satisfy when', () => {
  it('mapped file that does NOT satisfy when → type-when-mismatch', async () => {
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('mapped file that DOES satisfy when → no type-when-mismatch', async () => {
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
      await rm(root, { recursive: true, force: true });
    }
  });

  it('organizational type (no when) is never forward-checked', async () => {
    const { root, graph } = await buildProject({
      architecture: ['node_types:', '  module:', '    description: Organizational'].join('\n'),
      // A module CAN technically still have a mapping in the loaded graph; the
      // forward check simply skips it because when is undefined.
      files: [{ rel: 'src/a.ts', content: 'anything' }],
      nodes: [{ dir: 'mod', yaml: nodeYaml('mod', 'module', ['src/a.ts']) }],
    });
    try {
      const { issues } = await checkTypeWhenMismatch(graph, new FileContentCache());
      expect(issues.find((i) => i.code === 'type-when-mismatch')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// INVARIANT GROUP 3 — enforce: strict requires when
//   Doc: "enforce: strict requires `when`" (implied by "have `when`"; and the
//        'When to use enforce: strict' section presumes when present). Code
//        emits enforce-strict-without-when.
// ===========================================================================

describe('enforce: strict requires when', () => {
  it('enforce: strict WITHOUT when → enforce-strict-without-when', async () => {
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  command:',
        '    description: Command',
        '    enforce: strict',
      ].join('\n'),
      files: [],
      nodes: [],
    });
    try {
      const issues = checkEnforceStrictWithoutWhen(graph);
      expect(issues.find((i) => i.code === 'enforce-strict-without-when')).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('enforce: strict WITH when → no enforce-strict-without-when', async () => {
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  command:',
        '    description: Command',
        '    enforce: strict',
        '    when:',
        '      path: "src/cmd/**"',
      ].join('\n'),
      files: [],
      nodes: [],
    });
    try {
      const issues = checkEnforceStrictWithoutWhen(graph);
      expect(issues.find((i) => i.code === 'enforce-strict-without-when')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// INVARIANT GROUP 4 — Strict backward classification
//   Doc: "Strict enforcement fires two error codes:
//          - `type-strict-orphan` — file matches `when` but is in no mapping
//          - `type-strict-misplaced` — file matches `when` but is in a
//            wrong-type mapping"
//   Doc: "every file in the repo matching `when` must be in a mapping of this
//         type (backward)."
// ===========================================================================

describe('Strict backward classification', () => {
  const STRICT_ARCH = [
    'node_types:',
    '  command:',
    '    description: Command',
    '    enforce: strict',
    '    when:',
    '      content: "registerCommand"',
  ].join('\n');

  it('matching file in NO mapping → type-strict-orphan', async () => {
    const { root, graph } = await buildProject({
      architecture: STRICT_ARCH,
      files: [{ rel: 'src/loose.ts', content: 'registerCommand("x")' }],
      nodes: [],
    });
    try {
      const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      const orphan = issues.find((i) => i.code === 'type-strict-orphan');
      expect(orphan).toBeDefined();
      expect(orphan?.messageData.what).toContain('src/loose.ts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('matching file in a WRONG-type mapping → type-strict-misplaced', async () => {
    const { root, graph } = await buildProject({
      architecture: [
        STRICT_ARCH,
        '  utility:',
        '    description: Utility',
        '    when:',
        '      path: "**"',
      ].join('\n'),
      files: [{ rel: 'src/loose.ts', content: 'registerCommand("x")' }],
      nodes: [{ dir: 'util', yaml: nodeYaml('util', 'utility', ['src/loose.ts']) }],
    });
    try {
      const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      const misplaced = issues.find((i) => i.code === 'type-strict-misplaced');
      expect(misplaced).toBeDefined();
      expect(misplaced?.nodePath).toBe('util');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('matching file in the CORRECT-type mapping → neither orphan nor misplaced', async () => {
    const { root, graph } = await buildProject({
      architecture: STRICT_ARCH,
      files: [{ rel: 'src/cmd.ts', content: 'registerCommand("x")' }],
      nodes: [{ dir: 'cmd', yaml: nodeYaml('cmd', 'command', ['src/cmd.ts']) }],
    });
    try {
      const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      expect(issues.find((i) => i.code === 'type-strict-orphan')).toBeUndefined();
      expect(issues.find((i) => i.code === 'type-strict-misplaced')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a NON-strict type with when does NOT trigger backward enforcement (orphan)', async () => {
    // Doc: backward enforcement is gated on enforce: strict. A forward-only
    // classifying type must not produce strict-orphan for an unmapped match.
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      content: "registerCommand"',
      ].join('\n'),
      files: [{ rel: 'src/loose.ts', content: 'registerCommand("x")' }],
      nodes: [],
    });
    try {
      const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
      expect(issues.find((i) => i.code === 'type-strict-orphan')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// INVARIANT GROUP 5 — Strict orphan reported ALONGSIDE unmapped-files
//   Doc: "Both are reported alongside `unmapped-files` when applicable. They
//         are distinct symptoms with distinct fixes — no de-duplication."
// ===========================================================================

describe('Strict orphan co-reports with unmapped-files (no de-dup)', () => {
  it('an orphan strict file yields BOTH type-strict-orphan and unmapped-files', async () => {
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  command:',
        '    description: Command',
        '    enforce: strict',
        '    when:',
        '      content: "registerCommand"',
      ].join('\n'),
      files: [{ rel: 'src/loose.ts', content: 'registerCommand("x")' }],
      nodes: [],
    });
    try {
      // runCheck combines validation (strict scan) + coverage (unmapped) scans.
      // Pass the one source file as the git-tracked list so the coverage scan
      // sees it as uncovered.
      const result = await runCheck(graph, ['src/loose.ts']);
      const codes = result.issues.map((i) => i.code);
      expect(codes).toContain('type-strict-orphan');
      expect(codes).toContain('unmapped-files');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// INVARIANT GROUP 6 — Predicate grammar: path atom (glob)
//   Doc: "path atom ... Matches files whose repo-relative path matches the
//         glob."
//   Doc (Glob section): "`*` matches any characters within a single path
//         segment (does not cross `/`); `**` matches across path segments."
// ===========================================================================

describe('Predicate grammar — path atom glob semantics', () => {
  it('`*` matches within a single segment (does not cross `/`)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-bounty4-glob-'));
    try {
      const cache = new FileContentCache();
      const pred: FileWhenPredicate = { path: 'src/*.ts' };
      // direct child matches
      expect((await evaluateFileWhen(pred, ctxFor(root, 'src/a.ts', cache))).result).toBe(true);
      // nested child does NOT (single * cannot cross `/`)
      expect((await evaluateFileWhen(pred, ctxFor(root, 'src/sub/a.ts', cache))).result).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('`**` matches across path segments', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-bounty4-glob-'));
    try {
      const cache = new FileContentCache();
      const pred: FileWhenPredicate = { path: 'src/**/*.ts' };
      expect((await evaluateFileWhen(pred, ctxFor(root, 'src/a.ts', cache))).result).toBe(true);
      expect((await evaluateFileWhen(pred, ctxFor(root, 'src/deep/nested/a.ts', cache))).result).toBe(true);
      expect((await evaluateFileWhen(pred, ctxFor(root, 'other/a.ts', cache))).result).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('partial-segment glob owns only matching files directly in the dir (doc src/db/*Repository.cs)', async () => {
    // Doc Glob section: "src/db/*Repository.cs — owns only files matching
    // *Repository.cs directly inside src/db/, not subdirectory files or
    // non-matching files like Helper.cs."
    const root = await mkdtemp(path.join(tmpdir(), 'yg-bounty4-glob-'));
    try {
      const cache = new FileContentCache();
      const pred: FileWhenPredicate = { path: 'src/db/*Repository.cs' };
      expect((await evaluateFileWhen(pred, ctxFor(root, 'src/db/UserRepository.cs', cache))).result).toBe(true);
      expect((await evaluateFileWhen(pred, ctxFor(root, 'src/db/Helper.cs', cache))).result).toBe(false);
      expect((await evaluateFileWhen(pred, ctxFor(root, 'src/db/sub/XRepository.cs', cache))).result).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('path glob match does not require the file to exist on disk (path-only)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-bounty4-glob-'));
    try {
      const cache = new FileContentCache();
      const pred: FileWhenPredicate = { path: 'src/cli/**/*.ts' };
      // No such file written — a pure path predicate evaluates against the
      // string only and must not be marked unreadable.
      const r = await evaluateFileWhen(pred, ctxFor(root, 'src/cli/x.ts', cache));
      expect(r.result).toBe(true);
      expect(r.unreadable).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// INVARIANT GROUP 7 — Predicate grammar: content atom (regex)
//   Doc: "content atom ... Matches files whose content satisfies the regex."
//   Doc example: content: "register[A-Z]\\w*Command"
// ===========================================================================

describe('Predicate grammar — content atom regex', () => {
  it('content regex matches file content', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-bounty4-content-'));
    try {
      await writeFile(path.join(root, 'cli.ts'), 'function registerLogCommand() {}');
      const cache = new FileContentCache();
      const pred: FileWhenPredicate = { content: 'register[A-Z]\\w*Command' };
      const r = await evaluateFileWhen(pred, ctxFor(root, 'cli.ts', cache));
      expect(r.result).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('content regex is case-sensitive (no implicit i flag)', async () => {
    // The doc's content atom is a plain regex; the implementation compiles it
    // with `new RegExp(content)` and no flags, so matching is case-sensitive.
    const root = await mkdtemp(path.join(tmpdir(), 'yg-bounty4-content-'));
    try {
      await writeFile(path.join(root, 'cli.ts'), 'REGISTERCOMMAND');
      const cache = new FileContentCache();
      const r = await evaluateFileWhen({ content: 'registerCommand' }, ctxFor(root, 'cli.ts', cache));
      expect(r.result).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('content regex that does not match → false', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-bounty4-content-'));
    try {
      await writeFile(path.join(root, 'cli.ts'), 'function ordinaryFunction() {}');
      const cache = new FileContentCache();
      const pred: FileWhenPredicate = { content: 'register[A-Z]\\w*Command' };
      const r = await evaluateFileWhen(pred, ctxFor(root, 'cli.ts', cache));
      expect(r.result).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// INVARIANT GROUP 8 — Combining operators: all_of, any_of, not
//   Doc: "### Combining: all_of, any_of, not" with the documented example:
//        all_of: [ path, content, not: { path: "**/*.test.ts" } ]
// ===========================================================================

describe('Predicate grammar — all_of / any_of / not', () => {
  it('all_of requires EVERY child to pass', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-bounty4-bool-'));
    try {
      await mkdir(path.join(root, 'src', 'cli'), { recursive: true });
      await writeFile(path.join(root, 'src', 'cli', 'log.ts'), 'registerLogCommand();');
      const cache = new FileContentCache();
      const pred: FileWhenPredicate = {
        all_of: [
          { path: 'src/cli/**/*.ts' },
          { content: 'register[A-Z]\\w*Command' },
          { not: { path: '**/*.test.ts' } },
        ],
      };
      const ok = await evaluateFileWhen(pred, ctxFor(root, 'src/cli/log.ts', cache));
      expect(ok.result).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('all_of with a failing not-clause (documented test-file exclusion) → false', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-bounty4-bool-'));
    try {
      await mkdir(path.join(root, 'src', 'cli'), { recursive: true });
      await writeFile(path.join(root, 'src', 'cli', 'log.test.ts'), 'registerLogCommand();');
      const cache = new FileContentCache();
      const pred: FileWhenPredicate = {
        all_of: [
          { path: 'src/cli/**/*.ts' },
          { content: 'register[A-Z]\\w*Command' },
          { not: { path: '**/*.test.ts' } },
        ],
      };
      // The forgotten-not pitfall, inverted: WITH the not clause a *.test.ts file
      // is correctly excluded even though it matches the other two atoms.
      const r = await evaluateFileWhen(pred, ctxFor(root, 'src/cli/log.test.ts', cache));
      expect(r.result).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('any_of passes if AT LEAST ONE child passes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-bounty4-bool-'));
    try {
      await writeFile(path.join(root, 'x.py'), 'irrelevant');
      const cache = new FileContentCache();
      const pred: FileWhenPredicate = {
        any_of: [{ path: '**/*.ts' }, { content: 'irrelevant' }],
      };
      const r = await evaluateFileWhen(pred, ctxFor(root, 'x.py', cache));
      expect(r.result).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('not inverts its child', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-bounty4-bool-'));
    try {
      await writeFile(path.join(root, 'a.ts'), '');
      const cache = new FileContentCache();
      const r = await evaluateFileWhen({ not: { path: '**/*.py' } }, ctxFor(root, 'a.ts', cache));
      expect(r.result).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// INVARIANT GROUP 9 — Pitfall: "Overly broad when: `path: "**"` matches
//   everything."
// ===========================================================================

describe('Pitfall — path: "**" matches everything', () => {
  it('"**" matches files at root and any nesting depth', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-bounty4-broad-'));
    try {
      const cache = new FileContentCache();
      const pred: FileWhenPredicate = { path: '**' };
      expect((await evaluateFileWhen(pred, ctxFor(root, 'top.ts', cache))).result).toBe(true);
      expect((await evaluateFileWhen(pred, ctxFor(root, 'a/b/c/deep.md', cache))).result).toBe(true);
      expect((await evaluateFileWhen(pred, ctxFor(root, 'README', cache))).result).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// INVARIANT GROUP 10 — .yggdrasil/ auto-exempt
//   Doc (type-suggest workflow): "edge-case messages for files inside
//   `.yggdrasil/`". The evaluator auto-exempts (returns vacuously true).
// ===========================================================================

describe('.yggdrasil/ auto-exemption', () => {
  it('any path under .yggdrasil/ is vacuously true regardless of predicate', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-bounty4-exempt-'));
    try {
      const cache = new FileContentCache();
      // A predicate that would normally fail (no such path) still returns true.
      const r = await evaluateFileWhen({ path: 'src/**/*.ts' }, ctxFor(root, '.yggdrasil/model/x.yaml', cache));
      expect(r.result).toBe(true);
      expect(r.trace.kind).toBe('exempt');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// INVARIANT GROUP 11 — Pitfall: "a classifying type's parents can include
//   organizational types ... Validator imposes no semantic restriction."
// ===========================================================================

describe('Pitfall — organizational type as parent of a classifying type', () => {
  it('a classifying child under an organizational parent produces no parent-type error', async () => {
    // module (organizational, no when) is the parent of service (classifying).
    // Doc: validator imposes no semantic restriction on this combination.
    const { root, graph } = await buildProject({
      architecture: [
        'node_types:',
        '  module:',
        '    description: Organizational',
        '  service:',
        '    description: Service',
        '    parents: [module]',
        '    when:',
        '      path: "**"',
      ].join('\n'),
      files: [{ rel: 'src/a.ts', content: 'x' }],
      nodes: [
        { dir: 'plat', yaml: nodeYaml('plat', 'module', []) },
        { dir: 'plat/svc', yaml: nodeYaml('svc', 'service', ['src/a.ts']) },
      ],
    });
    try {
      const issues = checkArchitectureParents(graph);
      expect(issues.find((i) => i.code === 'parent-type-forbidden')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// INVARIANT GROUP 12 — type-suggest workflow edge-case messages (CLI-observable)
//   Doc: "Output shows matching types (✓), closest non-matching types ...,
//         or edge-case messages for files inside `.yggdrasil/` or for
//         non-existent files (path-only check)."
// ===========================================================================

describe.skipIf(!distExists)('type-suggest CLI edge-case messages', () => {
  async function makeRepo(): Promise<string> {
    const { root } = await buildProject({
      architecture: [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      path: "src/**/*.ts"',
      ].join('\n'),
      files: [{ rel: 'src/a.ts', content: 'export const a = 1;' }],
      nodes: [{ dir: 'svc', yaml: nodeYaml('svc', 'service', ['src/a.ts']) }],
    });
    return root;
  }

  function run(args: string[], cwd: string): { stdout: string; status: number | null } {
    const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
    return { stdout: r.stdout ?? '', status: r.status };
  }

  it('a file inside .yggdrasil/ → auto-exempt edge-case message', async () => {
    const root = await makeRepo();
    try {
      const { stdout } = run(['type-suggest', '--file', '.yggdrasil/yg-config.yaml'], root);
      expect(stdout).toMatch(/inside \.yggdrasil\/ — auto-exempt/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a non-existent file → path-only edge-case message', async () => {
    const root = await makeRepo();
    try {
      const { stdout } = run(['type-suggest', '--file', 'src/does-not-exist.ts'], root);
      expect(stdout).toMatch(/File does not exist — evaluating path predicates only/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a matching file shows the ✓ matching-types message', async () => {
    const root = await makeRepo();
    try {
      const { stdout } = run(['type-suggest', '--file', 'src/a.ts'], root);
      expect(stdout).toMatch(/Matching types/i);
      expect(stdout).toContain('service');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// INVARIANT GROUP 13 — End-to-end CLI: forward + strict-backward via `yg check`
//   Doc: type-when-mismatch (forward) and type-strict-orphan (backward) are
//        gate-blocking validation errors.
// ===========================================================================

describe.skipIf(!distExists)('yg check — architecture conformance (spawned)', () => {
  function gitInit(root: string): void {
    runGitFixture(root, ['init', '-q']);
    runGitFixture(root, ['config', 'user.email', 'a@b.c']);
    runGitFixture(root, ['config', 'user.name', 't']);
    runGitFixture(root, ['add', '-A']);
  }

  function check(root: string): { stdout: string; status: number | null } {
    const r = spawnSync('node', [BIN_PATH, 'check'], { cwd: root, encoding: 'utf-8' });
    return { stdout: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
  }

  it('forward mismatch: mapped file failing when → type-when-mismatch, exit 1', async () => {
    const { root } = await buildProject({
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
      gitInit(root);
      const { stdout, status } = check(root);
      expect(status).toBe(1);
      expect(stdout).toContain('type-when-mismatch');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('strict orphan: an unmapped matching file → type-strict-orphan, exit 1', async () => {
    const { root } = await buildProject({
      architecture: [
        'node_types:',
        '  command:',
        '    description: Command',
        '    enforce: strict',
        '    when:',
        '      content: "registerCommand"',
      ].join('\n'),
      files: [{ rel: 'src/loose.ts', content: 'registerCommand("x")' }],
      nodes: [],
    });
    try {
      gitInit(root);
      const { stdout, status } = check(root);
      expect(status).toBe(1);
      expect(stdout).toContain('type-strict-orphan');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// INVARIANT GROUP 14 — validate() pipeline ties it together
//   Doc: the architecture topic's checks are surfaced by `yg check`/validate.
// ===========================================================================

describe('validate() surfaces architecture conformance codes', () => {
  it('organizational-type-with-mapping is surfaced by validate()', async () => {
    const { root, graph } = await buildProject({
      architecture: ['node_types:', '  module:', '    description: Organizational'].join('\n'),
      files: [{ rel: 'src/a.ts', content: 'x' }],
      nodes: [{ dir: 'mod', yaml: nodeYaml('mod', 'module', ['src/a.ts']) }],
    });
    try {
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'type-without-when-with-mapping')).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
