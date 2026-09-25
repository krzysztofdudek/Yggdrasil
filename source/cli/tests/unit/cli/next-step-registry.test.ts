/**
 * The Next contract, held code by code: for every code the output registry
 * names, the step a report points at is one an agent can act on — a command
 * that parses against the real command tree, a graph file to change, the
 * location of a violation in the code, or a decision named as the user's.
 * Never a step read out of a sentence that sends the agent to a source file it
 * should not edit: for a file no node owns, the step is `yg context --file`,
 * which names the node whose mapping it belongs in.
 *
 * Each finding is made by the module that emits it in a real run — the
 * coverage builders, the pair-issue translation, the lock reader over a
 * corrupt lock, and the graph loader plus validator over broken graph files —
 * so a step the emitter hands over as data is exercised where it is set.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { enrichCheckJson } from '../../../src/cli/check-render-views.js';
import { buildCheckJson } from '../../../src/core/check-json.js';
import { REGISTERED_CODES } from '../../../src/cli/output-diagnostic.js';
import { emitPairIssue } from '../../../src/core/check-pair-issues.js';
import { buildCoverageIssue, buildCoverageAdvisoryIssue } from '../../../src/core/check-coverage-tiers.js';
import { readLock, LockInvalidError } from '../../../src/io/lock-store.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { validate } from '../../../src/core/validator.js';
import { nodeUnit } from '../../../src/model/lock.js';
import type { CheckIssue, CheckResult } from '../../../src/core/check.js';
import type { VerifiedPair } from '../../../src/core/verify-lock.js';
import type { CheckJsonNext } from '../../../src/formatters/check-json.js';
import { copyFixtureTree } from '../../support/fixture-copy.js';
import { registerInitCommand } from '../../../src/cli/init.js';
import { registerBuildCommand } from '../../../src/cli/build-context.js';
import { registerAspectsCommand } from '../../../src/cli/aspects.js';
import { registerCheckCommand } from '../../../src/cli/check.js';
import { registerLogCommand } from '../../../src/cli/log.js';
import { registerFindCommand } from '../../../src/cli/find.js';
import { registerTypeSuggestCommand } from '../../../src/cli/type-suggest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(__dirname, '../../fixtures/sample-project');

/**
 * The command tree a step's command must parse against: the real registrations
 * of every command a report's step names. A step naming any other command does
 * not parse here, which is the point — add its registration when a finding
 * starts pointing at it.
 */
function commandTree(): Command {
  const program = new Command().name('yg').enablePositionalOptions();
  for (const register of [
    registerInitCommand, registerBuildCommand, registerAspectsCommand, registerCheckCommand,
    registerLogCommand, registerFindCommand, registerTypeSuggestCommand,
  ]) register(program);
  return program;
}
const TREE = commandTree();

/**
 * Whether argv (`['yg', …]`) is a command the CLI accepts: each word names a
 * registered (sub)command until the options start, and every option is one
 * the command it reached declares.
 */
function parses(argv: string[]): boolean {
  let cmd: Command = TREE;
  let i = 1;
  while (i < argv.length && !argv[i].startsWith('-')) {
    const sub = cmd.commands.find((c) => c.name() === argv[i]);
    if (sub === undefined) break;
    cmd = sub;
    i++;
  }
  if (cmd === TREE) return false;
  const flags = argv.slice(i).filter((a) => a.startsWith('-'));
  return flags.every((f) => cmd.options.some((o) => o.long === f || o.short === f || o.long === f.replace(/^--no-/, '--')));
}

const isGraphFile = (file: string | undefined): boolean => file !== undefined && file.startsWith('.yggdrasil/');

function result(issues: CheckIssue[]): CheckResult {
  return {
    projectName: 't', nodeCount: 1, nodeTypeCounts: new Map(), aspectCount: 1, flowCount: 0,
    coveredFiles: 0, totalFiles: 0, issues, advisoryWarnings: 0, draftSkipped: 0,
    verifiedDet: 0, verifiedLlm: 0, pairs: [],
  } as CheckResult;
}
const nextOf = (issues: CheckIssue[]): CheckJsonNext | null => {
  const r = result(issues);
  return enrichCheckJson(buildCheckJson(r), r).next ?? null;
};

function verified(state: VerifiedPair['state'], kind: 'llm' | 'deterministic' = 'llm', extra: Partial<VerifiedPair> = {}): VerifiedPair {
  return {
    pair: { aspectId: 'readable-names', kind, unitKey: nodeUnit('app/svc'), nodePath: 'app/svc', status: 'enforced', subjectFiles: ['src/svc/index.ts'] },
    state,
    ...(kind === 'llm' ? { tierName: 'standard' } : {}),
    ...extra,
  };
}

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The sample project, copied, with one file replaced — the graph loader and validator then report what that file breaks. */
async function brokenGraph(rel: string, content: string | ((was: string) => string)): Promise<CheckIssue[]> {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-next-step-'));
  dirs.push(dir);
  copyFixtureTree(SAMPLE, dir);
  const file = path.join(dir, rel);
  writeFileSync(file, typeof content === 'string' ? content : content(readFileSync(file, 'utf-8')));
  const graph = await loadGraph(dir, { tolerateInvalidConfig: true });
  return (await validate(graph)).issues.filter((i) => i.code !== undefined).map((i) => ({ ...i, code: i.code! }));
}

function corruptLock(): CheckIssue {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-next-lock-'));
  dirs.push(dir);
  writeFileSync(path.join(dir, 'yg-lock.nondeterministic.json'), '{ not json');
  try {
    readLock(dir);
  } catch (err) {
    if (err instanceof LockInvalidError) return { severity: 'error', code: 'lock-invalid', rule: 'lock-invalid', messageData: err.messageData };
    throw err;
  }
  throw new Error('a garbled lock read without error');
}

/**
 * `command` runs as given; `template` is a command whose only gap is what a
 * person must supply (a log entry's reason), so it is named and shown, never
 * handed over as argv; the rest are a file or a decision.
 */
type Expect = 'command' | 'template' | 'graph-file' | 'violation' | 'code-change' | 'decision';

/** For every registered code: the finding its emitter produces, and what kind of step it must lead to. */
const CASES: Record<string, { expect: Expect; issues: () => Promise<CheckIssue[]> | CheckIssue[] }> = {
  'config-invalid': { expect: 'graph-file', issues: () => brokenGraph('.yggdrasil/yg-config.yaml', (was) => `${was}\ncoverage: 5\n`) },
  'architecture-invalid': { expect: 'graph-file', issues: () => brokenGraph('.yggdrasil/yg-architecture.yaml', 'node_types: [unclosed\n') },
  'yaml-invalid': { expect: 'graph-file', issues: () => brokenGraph('.yggdrasil/model/auth/yg-node.yaml', 'name: [unclosed\n') },
  'lock-invalid': { expect: 'graph-file', issues: () => [corruptLock()] },
  'aspect-violation-enforced': { expect: 'code-change', issues: () => emitPairIssue(verified({ kind: 'refused', reason: 'a name says nothing' }), []) },
  'aspect-violation-advisory': {
    expect: 'violation',
    issues: () => emitPairIssue({
      ...verified({ kind: 'refused', reason: 'src/svc/index.ts:3: TODO left in' }, 'deterministic'),
      pair: { aspectId: 'no-todo', kind: 'deterministic', unitKey: nodeUnit('app/svc'), nodePath: 'app/svc', status: 'advisory', subjectFiles: ['src/svc/index.ts'] },
    }, []),
  },
  'prompt-too-large': { expect: 'graph-file', issues: () => emitPairIssue(verified({ kind: 'prompt-too-large', chars: 90_000, limit: 50_000, tierName: 'standard' }), []) },
  'aspect-companion-runtime-error': {
    expect: 'graph-file',
    issues: () => emitPairIssue(verified({ kind: 'companion-error', messageData: { what: 'companion.mjs threw: boom', why: 'the prompt cannot be assembled', next: 'Fix the companion hook.' } }), []),
  },
  'unmapped-files': { expect: 'command', issues: () => [buildCoverageIssue(['README.md', 'src/orphan.ts', 'src/other.ts'], 10)!] },
  'uncovered-advisory': { expect: 'command', issues: () => [buildCoverageAdvisoryIssue(['scripts/tool.sh'])!] },
  'log-conflict': {
    expect: 'command',
    issues: () => [{ severity: 'error', code: 'log-conflict', rule: 'log-conflict', nodePath: 'app/svc', messageData: { what: 'Log contains git conflict markers', why: 'merge-resolve writes the union', next: 'yg log merge-resolve --node app/svc' } }],
  },
  'log-entry-missing': {
    expect: 'template',
    issues: () => [{ severity: 'error', code: 'log-entry-missing', rule: 'log-entry-missing', nodePath: 'app/svc', messageData: { what: "No fresh log entry for node 'app/svc'", why: 'log_required', next: "yg log add --node app/svc --reason '<why this change was made>'\nThen re-run yg check --approve." } }],
  },
  'config-reviewer-missing': {
    expect: 'decision',
    issues: () => [{ severity: 'error', code: 'config-reviewer-missing', rule: 'config-reviewer-missing', messageData: { what: 'A judgment rule has no judge.', why: "the user's decision", next: 'yg init --provider <name>' } }],
  },
  unverified: { expect: 'command', issues: () => emitPairIssue(verified({ kind: 'unverified' }), [], { reviewerConfigured: true, consensusOf: () => 3 }) },
};

describe('the Next step of every registered code', () => {
  it('every registered code has a case here', () => {
    expect(Object.keys(CASES).sort()).toEqual([...REGISTERED_CODES].sort());
  });

  for (const code of REGISTERED_CODES) {
    it(`${code}: the step is actionable as data, never a file fished out of prose`, async () => {
      const found = (await CASES[code].issues()).filter((i) => i.code === code);
      expect(found.length, `the emitter produced no ${code} finding`).toBeGreaterThan(0);
      const next = nextOf(found);
      expect(next).not.toBeNull();
      switch (CASES[code].expect) {
        case 'command':
          expect(next!.command, `${code}: ${next!.text}`).not.toBeNull();
          expect(parses(next!.command!), `${code}: ${next!.command!.join(' ')}`).toBe(true);
          break;
        case 'template': {
          expect(next!.command).toBeNull();
          const argv = (next!.text.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^['"]|['"]$/g, ''));
          expect(argv[0]).toBe('yg');
          expect(parses(argv), `${code}: ${next!.text}`).toBe(true);
          expect(argv.some((t) => /^<[^>]+>$/.test(t))).toBe(true);
          break;
        }
        case 'graph-file':
          expect(isGraphFile(next!.target.file), `${code}: ${next!.text}`).toBe(true);
          break;
        case 'violation':
          expect(next!.target.file).toBe('src/svc/index.ts');
          expect(next!.text).toBe('edit src/svc/index.ts:3');
          break;
        case 'code-change':
          expect(next!.command).toBeNull();
          expect(next!.target.node).toBe('app/svc');
          break;
        case 'decision':
          expect(next!.requiresUser).toBe(true);
          expect(next!.command).toBeNull();
          break;
      }
    });
  }

  it('a file no node owns leads to the node its mapping belongs in — never to editing that file', () => {
    for (const files of [['src/orphan.ts'], ['README.md', 'src/o1.ts', 'src/o2.ts', 'src/o3.ts']]) {
      const next = nextOf([buildCoverageIssue(files, 10)!])!;
      expect(next.command).toEqual(['yg', 'context', '--file', files.find((f) => f.endsWith('.ts'))!]);
      expect(next.target.file).toBeUndefined();
      expect(next.text.startsWith('edit ')).toBe(false);
    }
  });

  it('a README-only repository still names a file to read about', () => {
    const next = nextOf([buildCoverageIssue(['README.md'], 1)!])!;
    expect(next.command).toEqual(['yg', 'context', '--file', 'README.md']);
  });

  it('a fix whose words name a source file never makes it the target', () => {
    const next = nextOf([{ severity: 'error', code: 'some-structural-code', rule: 'x', nodePath: 'app/svc', messageData: { what: 'w', why: 'y', next: 'Fix the import in src/svc/index.ts so it names a declared relation.' } }])!;
    expect(next.target.file).toBeUndefined();
    expect(next.text).toBe('Fix the import in src/svc/index.ts so it names a declared relation');
  });
});

describe('one Next engine', () => {
  const SRC = path.resolve(__dirname, '../../../src');
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);

  it('the engine that computed a step inside the check, only to have the report overwrite it, is gone', () => {
    expect(existsSync(path.join(SRC, 'core/check-suggested-next.ts'))).toBe(false);
  });

  it('only the report sets the step a check points at', () => {
    const writers = sources(SRC)
      .filter((f) => /\.suggestedNext\s*=(?!=)/.test(readFileSync(f, 'utf-8')))
      .map((f) => path.relative(SRC, f).split(path.sep).join('/'));
    expect(writers).toEqual(['cli/check-render-views.ts']);
  });
});

