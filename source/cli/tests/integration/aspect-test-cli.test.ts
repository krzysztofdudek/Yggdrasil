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
`;

// A self-contained AST check using the raw tree-sitter Node API (no @chrisdudek/yg
// import) so it loads from /tmp without the loader hook. Flags sync fs calls.
const SYNC_FS_CHECK_MJS = `export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const calls = file.ast.rootNode.descendantsOfType('call_expression');
    for (const node of calls) {
      const fn = node.childForFieldName('function');
      if (!fn) continue;
      if (fn.text.includes('readFileSync') || fn.text.includes('writeFileSync')) {
        violations.push({ file: file.path, line: node.startPosition.row + 1, message: 'Use async fs APIs instead of sync' });
      }
    }
  }
  return violations;
}
`;

const BAD_TS = `import fs from 'node:fs';
export function readConfig(p) {
  return fs.readFileSync(p, 'utf-8');
}
`;

const CLEAN_TS = `import fs from 'node:fs/promises';
export async function readConfig(p) {
  return fs.readFile(p, 'utf-8');
}
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

function makeBaseProject(projectRoot: string): void {
  const ygg = path.join(projectRoot, '.yggdrasil');
  mkdirSync(path.join(ygg, 'model', 'N'), { recursive: true });
  mkdirSync(path.join(ygg, 'aspects'), { recursive: true });
  mkdirSync(path.join(projectRoot, 'src'), { recursive: true });

  writeFileSync(path.join(ygg, 'yg-config.yaml'), YG_CONFIG);
  writeFileSync(path.join(ygg, 'yg-architecture.yaml'), YG_ARCH);
  writeFileSync(path.join(projectRoot, 'src', 'a.ts'), 'export const x = 1;\n');
  writeFileSync(
    path.join(ygg, 'model', 'N', 'yg-node.yaml'),
    `name: NodeN\ntype: module\nmapping:\n  - src/a.ts\n`,
  );
}

function writeAspect(projectRoot: string, id: string, yaml: string, check: string): void {
  const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', id);
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(path.join(aspectDir, 'yg-aspect.yaml'), yaml);
  writeFileSync(path.join(aspectDir, 'check.mjs'), check);
}

// `yg aspect-test` replaces `yg deterministic-test`: it runs an aspect check
// WITHOUT touching the lock (diagnostic only), against a graph node (--node) or
// ad-hoc files (--files, deterministic only). Every run ends with the footer
// "diagnostic only — lock unchanged".
describe.skipIf(!distExists)('yg aspect-test', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-aspect-test-cli-'));
    makeBaseProject(projectRoot);
  });

  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  // --- aspect / argument validation (shared by both modes) -----------------

  it('prints error and exits 1 when aspect is not found (mentions yg aspect-test)', () => {
    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'nonexistent', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toContain("'nonexistent' not found");
    expect(stderr).toContain('yg aspect-test');
  });

  it('rejects --files with an llm aspect id (LLM needs graph context)', () => {
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', 'llm-aspect');
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(
      path.join(aspectDir, 'yg-aspect.yaml'),
      `name: LlmAspect\ndescription: llm aspect\nreviewer:\n  type: llm\n`,
    );
    writeFileSync(path.join(aspectDir, 'content.md'), `Code must be tidy.\n`);

    // --files is deterministic-only: an LLM review requires the node mapping,
    // effective aspects and tier config that an ad-hoc file list cannot supply.
    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'llm-aspect', '--files', 'src/a.ts'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toContain('--files cannot be used with LLM aspect');
  });

  it('exits 1 when neither --node nor --files is provided', () => {
    writeAspect(
      projectRoot,
      'clean',
      `name: Clean\ndescription: clean\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return []; }\n`,
    );
    const { stderr, status } = run(['aspect-test', '--aspect', 'clean'], projectRoot);
    expect(status).toBe(1);
    expect(stderr).toContain('Neither --node nor --files');
  });

  it('exits 1 when BOTH --node and --files are provided', () => {
    writeAspect(
      projectRoot,
      'clean',
      `name: Clean\ndescription: clean\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return []; }\n`,
    );
    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'clean', '--node', 'N', '--files', 'src/a.ts'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toContain('Both --node and --files');
  });

  it('--dry-run is rejected for a deterministic aspect (no prompt to print)', () => {
    writeAspect(
      projectRoot,
      'clean',
      `name: Clean\ndescription: clean\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return []; }\n`,
    );
    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'clean', '--node', 'N', '--dry-run'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toContain('--dry-run is not supported for deterministic aspect');
  });

  // --- stderr contract: bespoke errors carry the 'Error: ' prefix ----------

  // Every bespoke aspect-test error path writes `Error: <what/why/next>` to
  // stderr. Pin the prefix at POSITION 0 (regex ^Error: , not a substring
  // match) on three representative paths, so stripping the prefix from the
  // stderr writes is a test failure — a bare toContain('Error') would still
  // pass on wording that merely mentions the word.

  it("stderr starts with 'Error: ' when the aspect is not found", () => {
    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'nonexistent', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toMatch(/^Error: /);
  });

  it("stderr starts with 'Error: ' when --files is used with an LLM aspect", () => {
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', 'llm-aspect');
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(
      path.join(aspectDir, 'yg-aspect.yaml'),
      `name: LlmAspect\ndescription: llm aspect\nreviewer:\n  type: llm\n`,
    );
    writeFileSync(path.join(aspectDir, 'content.md'), `Code must be tidy.\n`);

    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'llm-aspect', '--files', 'src/a.ts'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toMatch(/^Error: /);
  });

  it("stderr starts with 'Error: ' when the node is not found", () => {
    writeAspect(
      projectRoot,
      'det-prefix',
      `name: DetPrefix\ndescription: det prefix\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return []; }\n`,
    );
    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'det-prefix', '--node', 'missing/node'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toMatch(/^Error: /);
  });

  // --- --node mode (graph-aware ctx) ---------------------------------------

  it('--node runs deterministic aspect against named node and prints violations', () => {
    writeAspect(
      projectRoot,
      'test',
      `name: Test\ndescription: test aspect\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return [{ message: 'hi' }]; }\n`,
    );
    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'test', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stdout).toContain('hi');
    // Diagnostic footer: the run never touches the lock.
    expect(stdout).toContain('diagnostic only — lock unchanged');
  });

  it('--node prints "No violations." and exits 0 when check returns empty array', () => {
    writeAspect(
      projectRoot,
      'clean',
      `name: Clean\ndescription: clean aspect\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return []; }\n`,
    );
    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'clean', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(0);
    expect(stdout).toContain('No violations.');
    expect(stdout).toContain('diagnostic only — lock unchanged');
  });

  it('--node prints error when node is not found', () => {
    writeAspect(
      projectRoot,
      'test2',
      `name: Test2\ndescription: test2\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return []; }\n`,
    );
    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'test2', '--node', 'missing/node'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toContain("'missing/node' not found");
  });

  it('--node renders file violations with file path and line (L<line>)', () => {
    writeAspect(
      projectRoot,
      'with-file',
      `name: WithFile\ndescription: with file\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) {
  return [{ message: 'found issue', file: 'src/a.ts', line: 1, column: 0 }];
}\n`,
    );
    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'with-file', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stdout).toContain('src/a.ts');
    expect(stdout).toContain('L1: found issue');
  });

  it('--node refusal: the verdict stamp is the first line, before any file path', () => {
    writeAspect(
      projectRoot,
      'stamped',
      `name: Stamped\ndescription: stamped\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) {
  return [{ message: 'found issue', file: 'src/a.ts', line: 1 }];
}\n`,
    );
    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'stamped', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stdout.split('\n')[0]).toBe('yg aspect-test: refused — 1 violation');
    expect(stdout.indexOf('yg aspect-test: refused')).toBeLessThan(stdout.indexOf('src/a.ts'));
  });

  it('--node clean run pins the full satisfied stamp and the full diagnostic footer', () => {
    writeAspect(
      projectRoot,
      'clean',
      `name: Clean\ndescription: clean aspect\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return []; }\n`,
    );
    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'clean', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(0);
    expect(stdout).toContain('yg aspect-test: satisfied — No violations.');
    // Full footer wording, pinned once against a real fixture.
    expect(stdout).toContain(
      'diagnostic only — lock unchanged; yg check judges the lock against your files, not this run',
    );
  });

  it('--node renders a line-less file violation as a bare message (no L?: placeholder)', () => {
    writeAspect(
      projectRoot,
      'no-line',
      `name: NoLine\ndescription: no line\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) {
  return [{ message: 'file-level issue', file: 'src/a.ts' }];
}\n`,
    );
    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'no-line', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stdout).toContain('src/a.ts');
    expect(stdout).toContain('  file-level issue');
    expect(stdout).not.toContain('L?');
  });

  it('--node runs a DRAFT deterministic aspect live and exits 1 on violations (status never gates aspect-test)', () => {
    writeAspect(
      projectRoot,
      'draft-det',
      `name: DraftDet\ndescription: draft det\nreviewer:\n  type: deterministic\nstatus: draft\n`,
      `export function check(ctx) { return [{ message: 'draft still runs' }]; }\n`,
    );
    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'draft-det', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stdout).toContain('draft still runs');
  });

  it('--node renders graph-level violations (no file) as <graph>:', () => {
    writeAspect(
      projectRoot,
      'graph-level',
      `name: GraphLevel\ndescription: graph level\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return [{ message: 'graph violation' }]; }\n`,
    );
    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'graph-level', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stdout).toContain('<graph>: graph violation');
  });

  it('--node surfaces a broken check (default export instead of named) with exit 1', () => {
    writeAspect(
      projectRoot,
      'broken',
      `name: Broken\ndescription: broken\nreviewer:\n  type: deterministic\n`,
      `export default function check(ctx) { return []; }\n`,
    );
    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'broken', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(1);
    // The structure runner error is now rendered as its structured what/why/next
    // (parity with the --files path), so assert the human wording, not the
    // internal DEFAULT_EXPORT code token, and confirm the generic
    // "does not classify / file an issue" wrapper is absent.
    expect(stderr).toContain('NAMED export is required');
    expect(stderr).not.toContain('DEFAULT_EXPORT');
    expect(stderr).not.toContain('please file an issue');
  });

  it('--node --check-determinism exits 0 when results are stable', () => {
    writeAspect(
      projectRoot,
      'stable',
      `name: Stable\ndescription: stable aspect\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return []; }\n`,
    );
    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'stable', '--node', 'N', '--check-determinism'],
      projectRoot,
    );
    expect(status).toBe(0);
    expect(stdout).toContain('No violations.');
  });

  it('--node --check-determinism exits 1 with Run 1/Run 2 dump for a non-deterministic check', () => {
    // A module-level counter makes the first invocation differ from the second,
    // so two consecutive runs within the process reliably disagree.
    writeAspect(
      projectRoot,
      'flaky-node',
      `name: FlakyNode\ndescription: flaky\nreviewer:\n  type: deterministic\n`,
      `let calls = 0;
export function check(ctx) {
  calls += 1;
  if (calls === 1) return [{ message: 'first-run-only violation' }];
  return [];
}
`,
    );
    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'flaky-node', '--node', 'N', '--check-determinism'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toContain('non-deterministic');
    expect(stderr).toContain('Run 1:');
    expect(stderr).toContain('Run 2:');
  });

  // --- --node effectiveness NOTE (deterministic, ad-hoc test-before-attach) --

  it('--node deterministic: prints a NOTE to stderr when the aspect is not attached to the node', () => {
    // Node N (module) declares no aspects, so this aspect is not effective on it
    // through any channel. The ad-hoc run still executes (test-before-attach),
    // but a NOTE now warns that yg check produces no verdict for this pair —
    // restoring symmetry with the LLM path's "No pairs".
    writeAspect(
      projectRoot,
      'unattached',
      `name: Unattached\ndescription: unattached\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return []; }\n`,
    );
    const { stdout, stderr, status } = run(
      ['aspect-test', '--aspect', 'unattached', '--node', 'N'],
      projectRoot,
    );
    // The ad-hoc run itself is unchanged: clean check, exit 0, verdict on stdout.
    expect(status).toBe(0);
    expect(stdout).toContain('No violations.');
    // The NOTE lands on stderr, naming the aspect and node.
    expect(stderr).toContain("Note: aspect 'unattached' is not attached to node 'N'");
    expect(stderr).toContain('yg check will not produce a verdict for this pair');
    // It is a stderr NOTE, not mixed into the verdict output.
    expect(stdout).not.toContain('is not attached to node');
  });

  it('--node deterministic: prints NO note when the aspect IS attached to the node', () => {
    writeAspect(
      projectRoot,
      'attached',
      `name: Attached\ndescription: attached\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return []; }\n`,
    );
    // Attach the aspect to node N (channel 1 — own) so it is effective there.
    writeFileSync(
      path.join(projectRoot, '.yggdrasil', 'model', 'N', 'yg-node.yaml'),
      `name: NodeN\ntype: module\naspects:\n  - attached\nmapping:\n  - src/a.ts\n`,
    );
    const { stdout, stderr, status } = run(
      ['aspect-test', '--aspect', 'attached', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(0);
    expect(stdout).toContain('No violations.');
    // Effective on N → the pair exists → no note.
    expect(stderr).not.toContain('is not attached to node');
  });

  it('--node deterministic: prints NO note on an ORGANIZATIONAL/fileless node whose aspect cascades (regression)', () => {
    // An organizational node (module type, NO own mapping) can carry an aspect
    // that is genuinely effective — its pairs materialize at file-bearing
    // DESCENDANTS via cascade, never at the fileless parent itself. Attachment
    // must be decided by effectiveness (the full 7-channel cascade), not by "a
    // pair exists at this exact node"; the latter falsely reads the parent as
    // "not attached" because it owns no files and thus no pair of its own.
    writeAspect(
      projectRoot,
      'cascade',
      `name: Cascade\ndescription: cascade\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return []; }\n`,
    );
    // Parent ORG node: module, NO mapping, owns `cascade` (channel 1 — own).
    mkdirSync(path.join(projectRoot, '.yggdrasil', 'model', 'ORG', 'CH'), {
      recursive: true,
    });
    writeFileSync(
      path.join(projectRoot, '.yggdrasil', 'model', 'ORG', 'yg-node.yaml'),
      `name: Org\ntype: module\naspects:\n  - cascade\n`,
    );
    // File-bearing child: the aspect's pair materializes HERE, proving `cascade`
    // is genuinely effective across the ORG subtree even though ORG has no file.
    writeFileSync(path.join(projectRoot, 'src', 'b.ts'), 'export const y = 2;\n');
    writeFileSync(
      path.join(projectRoot, '.yggdrasil', 'model', 'ORG', 'CH', 'yg-node.yaml'),
      `name: Child\ntype: module\nmapping:\n  - src/b.ts\n`,
    );
    const { stdout, stderr, status } = run(
      ['aspect-test', '--aspect', 'cascade', '--node', 'ORG'],
      projectRoot,
    );
    expect(status).toBe(0);
    // ORG bears no files → the ad-hoc structure run finds nothing to flag.
    expect(stdout).toContain('No violations.');
    // Effective via the own-attach cascade, though ORG has no pair of its own.
    expect(stderr).not.toContain('is not attached to node');
  });

  it('--node deterministic: a DRAFT aspect attached to its own node reads as attached (no note)', () => {
    // includeDraft parity: draft is a STATUS, not an attach channel. A draft
    // aspect attached to a node is still effective on it (status gates the
    // lock/fill, never this diagnostic), so testing it on its own node must
    // NOT print the "not attached" note.
    writeAspect(
      projectRoot,
      'draft-attached',
      `name: DraftAttached\ndescription: draft attached\nreviewer:\n  type: deterministic\nstatus: draft\n`,
      `export function check(ctx) { return []; }\n`,
    );
    writeFileSync(
      path.join(projectRoot, '.yggdrasil', 'model', 'N', 'yg-node.yaml'),
      `name: NodeN\ntype: module\naspects:\n  - draft-attached\nmapping:\n  - src/a.ts\n`,
    );
    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'draft-attached', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(0);
    expect(stderr).not.toContain('is not attached to node');
  });

  // --- --files mode (AST runner + AST renderer) ----------------------------

  it('--files prints "No violations." and exits 0 for a clean file', () => {
    writeAspect(
      projectRoot,
      'async-fs',
      `name: AsyncFS\ndescription: async fs\nreviewer:\n  type: deterministic\n`,
      SYNC_FS_CHECK_MJS,
    );
    writeFileSync(path.join(projectRoot, 'src', 'clean.ts'), CLEAN_TS);

    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'async-fs', '--files', 'src/clean.ts'],
      projectRoot,
    );
    expect(status).toBe(0);
    expect(stdout).toContain('No violations.');
  });

  it('--files reports violations for a file using sync fs APIs (L<line>)', () => {
    writeAspect(
      projectRoot,
      'async-fs',
      `name: AsyncFS\ndescription: async fs\nreviewer:\n  type: deterministic\n`,
      SYNC_FS_CHECK_MJS,
    );
    writeFileSync(path.join(projectRoot, 'src', 'bad.ts'), BAD_TS);

    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'async-fs', '--files', 'src/bad.ts'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stdout).toContain('src/bad.ts');
    expect(stdout).toMatch(/L\d+: Use async fs APIs/);
  });

  it('--files groups violations by file across multiple files', () => {
    writeAspect(
      projectRoot,
      'async-fs',
      `name: AsyncFS\ndescription: async fs\nreviewer:\n  type: deterministic\n`,
      SYNC_FS_CHECK_MJS,
    );
    writeFileSync(path.join(projectRoot, 'src', 'a-bad.ts'), BAD_TS);
    writeFileSync(path.join(projectRoot, 'src', 'b-bad.ts'), BAD_TS);

    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'async-fs', '--files', 'src/b-bad.ts', 'src/a-bad.ts'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stdout).toContain('src/a-bad.ts');
    expect(stdout).toContain('src/b-bad.ts');
    // The renderer sorts file groups alphabetically: a-bad before b-bad.
    expect(stdout.indexOf('src/a-bad.ts')).toBeLessThan(stdout.indexOf('src/b-bad.ts'));
  });

  it('--files surfaces a broken check (default export instead of named) with exit 1', () => {
    writeAspect(
      projectRoot,
      'broken-ast',
      `name: BrokenAst\ndescription: broken\nreviewer:\n  type: deterministic\n`,
      `export default function check(ctx) { return []; }\n`,
    );
    writeFileSync(path.join(projectRoot, 'src', 'x.ts'), 'export const y = 1;\n');

    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'broken-ast', '--files', 'src/x.ts'],
      projectRoot,
    );
    expect(status).toBe(1);
    // The AST runner's error does not prefix the code token into .message
    // (unlike the structure runner), so assert on the human wording.
    expect(stderr).toContain('NAMED export is required');
  });

  it('--files --check-determinism exits 0 when results are stable', () => {
    writeAspect(
      projectRoot,
      'async-fs',
      `name: AsyncFS\ndescription: async fs\nreviewer:\n  type: deterministic\n`,
      SYNC_FS_CHECK_MJS,
    );
    writeFileSync(path.join(projectRoot, 'src', 'clean.ts'), CLEAN_TS);

    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'async-fs', '--files', 'src/clean.ts', '--check-determinism'],
      projectRoot,
    );
    expect(status).toBe(0);
    expect(stdout).toContain('No violations.');
  });

  it('--files --check-determinism exits 1 with Run 1/Run 2 dump for a non-deterministic check', () => {
    // A module-level counter makes the two consecutive in-process runs disagree.
    writeAspect(
      projectRoot,
      'flaky-files',
      `name: FlakyFiles\ndescription: flaky\nreviewer:\n  type: deterministic\n`,
      `let calls = 0;
export function check(ctx) {
  calls += 1;
  if (calls === 1) {
    return ctx.files.map((f) => ({ file: f.path, line: 1, message: 'first-run-only violation' }));
  }
  return [];
}
`,
    );
    writeFileSync(path.join(projectRoot, 'src', 'clean.ts'), CLEAN_TS);

    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'flaky-files', '--files', 'src/clean.ts', '--check-determinism'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toContain('non-deterministic');
    expect(stderr).toContain('Run 1:');
    expect(stderr).toContain('Run 2:');
  });
});
