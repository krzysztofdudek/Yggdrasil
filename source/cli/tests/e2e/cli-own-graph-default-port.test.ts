// =============================================================================
// CLI E2E — the `atomic-write-contract` port, migrated to `default`, on THIS
// repository's own graph.
//
// `cli/io/atomic-write` used to publish a named port (`write-atomic`) that nine
// nodes declared `consumes: [write-atomic]` on. Of those nine, only three are
// `persistence-adapter` — the type `atomic-write-contract` itself restricts to
// via its own `when`. The other six already got nothing from the port: the
// aspect never reached them, because attachment always re-checks `when`
// regardless of which channel carried the aspect there. The migration drops
// the name (the port becomes `default`, the reserved implicit port every
// relation naming none already enters through) and removes all nine
// `consumes` declarations — proving that reach through a port and eligibility
// under a `when` filter are two separate questions, and that the second one
// alone decides who is actually bound by the rule.
//
//   1. the `atomic-write-contract` pair set on this repo's own graph is
//      exactly the recorded baseline
//   2. no pair carries `unverified` or `stale` because of this migration,
//      after the free deterministic fill
//   3. `cli/io/atomic-write`'s port is named `default`, not `write-atomic`,
//      and carries neither `version` nor `test`
//   4. `yg impact --node cli/io/atomic-write --json` names all nine former
//      consumers on the `default` port's consumer list — reach through the
//      port, independent of how many the `when` filter later accepts
//   5. `yg context --node cli/io/lock-store` shows `atomic-write-contract`
//      effective through two channels at once: `own-type` and a `port`
//      channel with origin `default@cli/io/atomic-write`
//   6. `yg context --node cli/core/check` shows the aspect NOT effective —
//      the port relation reaches it, but its type fails the `when` filter
//   7. no `.yggdrasil/model/**` file mentions `consumes:` or `write-atomic`
//      any more, except the historical entry in `cli/io/stores/log.md`
// =============================================================================

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
// This CLI's own repository — the graph this migration actually touches, and
// the one the ticket states its acceptance against.
const REPO_ROOT = path.resolve(CLI_ROOT, '..', '..');
const distExists = existsSync(BIN_PATH);

function run(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

interface CheckDoc {
  totals: { verdicts: Record<string, number> };
  pairs: Array<{ aspect: string; node: string | null; verdict: string }>;
}

interface NodeDoc {
  ports: Record<string, { description: string; aspects: string[]; version?: number; test?: string }>;
}

interface ImpactDoc {
  ports: Array<{ name: string; consumers: Array<{ node: string; relation: string }> }>;
}

interface ContextDoc {
  aspects: Array<{
    id: string;
    channels: Array<{ number: number; kind: string; origin: string }>;
  }>;
}

// The pair set measured BEFORE this migration touched a single file, via the
// exact commands the ticket names:
//   node dist/bin.js check --json | jq '[.pairs[] | select(.aspect=="atomic-write-contract")] | length'
//   node dist/bin.js check --json | jq -r '[.pairs[] | select(.aspect=="atomic-write-contract") | .node] | sort'
// which returned 5 and this list. `cli/io/atomic-write` itself was ABSENT from
// that measurement — not because the type-default channel didn't reach it (its
// type is `persistence-adapter`, and `atomic-write-contract` is one of that
// type's default aspects, same as it is for every node below), but because its
// own yg-node.yaml failed to PARSE at that moment: the port still carried
// `version`/`test`, fields 6.0.0 refuses outright, so the whole node was
// invalid and absent from the graph, and everything declaring a relation onto
// it saw a broken target instead. That parse failure was orthogonal to
// anything this migration decides — dropping `version`/`test` is mandatory
// once the schema moved to 6.0.0, port migration or not. The moment the node
// parses again, it is exactly as eligible for its own type's default aspects
// as it always was, so it gains its own pair. Isolating the two changes
// confirms this: fixing only the invalid fields (no rename, no `consumes`
// removal) already produces the 6-node set below, and diffing the FULL pair
// set (every aspect, not just this one) between that state and the fully
// migrated one is empty — the rename and the nine `consumes` removals change
// zero pairs anywhere in the graph. The widening from 5 to 6 is real, but it
// is not this migration's doing.
const EXPECTED_PAIR_NODES = ['cli/io/atomic-write', 'cli/io/file-content-cache', 'cli/io/incident-ledger', 'cli/io/lock-store', 'cli/io/stores', 'cli/io/type-class-cache'];

const FORMER_CONSUMERS = [
  'cli/portal/serializer',
  'cli/core/check',
  'cli/relations/core',
  'cli/io/type-class-cache',
  'cli/io/stores',
  'cli/io/lock-store',
  'cli/tests/unit/support/io',
  'cli/tests/unit/support/utils',
  'cli/commands/check',
];

/**
 * Consumers that reach the same port but never declared `consumes:` — they were
 * written after the field was retired, so they are not "former" anything and
 * kept out of the list above, which is a record of what that migration moved.
 * Scenario 4 is about REACH through the port, which is both sets.
 */
const LATER_CONSUMERS = ['cli/commands/pack', 'cli/commands/marketplace'];

// The two expensive full-graph reads (each a `check --json` walk over all 445
// nodes) run exactly once each, in `beforeAll`, with their results held here —
// one before the free deterministic fill, one after — rather than re-run per
// scenario. Everything scenarios 3-7 need is a cheap, single-node query
// (`node`, `impact`, `context`) or a local file walk, not a full graph pass,
// so those are not subject to the same cap.
let beforeFill: CheckDoc;
let afterFill: CheckDoc;

// The fill below writes nothing this suite has to undo, and nothing a later run
// of it can inherit. `--only-deterministic` touches exactly one file — the
// deterministic-verdict cache at `.yggdrasil/.yg-lock.deterministic.json`, which
// is gitignored (`.yggdrasil/.gitignore`) precisely because it is rebuildable
// derived state; no tracked file changes, verified by diffing `git status` across
// the command. Its entries are keyed by input hash, so a stale one cannot be read
// as a current verdict. And the repository's own gate runs the identical command
// as a PREREQUISITE step before this suite ever starts, so the state these tests
// meet is the state the gate put there either way. A temp-directory copy would
// not do instead: this suite exists to measure THIS repository's graph, which is
// what the migration it guards actually changed.
beforeAll(() => {
  beforeFill = JSON.parse(run(['check', '--json']).stdout) as CheckDoc;
  run(['check', '--approve', '--only-deterministic']);
  afterFill = JSON.parse(run(['check', '--json']).stdout) as CheckDoc;
}, 180_000);

describe.skipIf(!distExists)('CLI E2E — own-graph atomic-write-contract port migration', () => {
  it('1: the atomic-write-contract pair set equals the recorded pre-migration baseline, widened only by the parse-error fix', () => {
    const actual = [...new Set(beforeFill.pairs.filter((p) => p.aspect === 'atomic-write-contract').map((p) => p.node).filter((n): n is string => n !== null))].sort();
    const expected = [...EXPECTED_PAIR_NODES].sort();
    if (actual.join(',') !== expected.join(',')) {
      const added = actual.filter((n) => !expected.includes(n));
      const removed = expected.filter((n) => !actual.includes(n));
      throw new Error(`atomic-write-contract pair set changed.\n  added:   ${JSON.stringify(added)}\n  removed: ${JSON.stringify(removed)}\n  actual:  ${JSON.stringify(actual)}\n  expected:${JSON.stringify(expected)}`);
    }
    expect(actual).toEqual(expected);
  });

  it('2: no pair is unverified or stale because of this migration, once the free deterministic fill runs', () => {
    const ours = afterFill.pairs.filter((p) => p.aspect === 'atomic-write-contract');
    const bad = ours.filter((p) => p.verdict === 'unverified' || p.verdict === 'stale');
    expect(bad).toEqual([]);
  });

  it('3: the atomic-write port is named default, and carries neither version nor test', () => {
    const doc = JSON.parse(run(['node', '--json', 'cli/io/atomic-write']).stdout) as NodeDoc;
    expect(Object.keys(doc.ports)).toEqual(['default']);
    expect(doc.ports['write-atomic']).toBeUndefined();
    expect(doc.ports.default.version).toBeUndefined();
    expect(doc.ports.default.test).toBeUndefined();
    expect(doc.ports.default.aspects).toEqual(['atomic-write-contract']);
  });

  it('4: impact on the default port lists every node that reaches it — reach through the port, not eligibility under the rule', () => {
    const doc = JSON.parse(run(['impact', '--node', 'cli/io/atomic-write', '--json']).stdout) as ImpactDoc;
    const defaultPort = doc.ports.find((p) => p.name === 'default');
    expect(defaultPort).toBeDefined();
    const consumers = defaultPort!.consumers.map((c) => c.node).sort();
    expect(consumers).toEqual([...FORMER_CONSUMERS, ...LATER_CONSUMERS].sort());
  });

  it('5: lock-store gets atomic-write-contract through two channels at once — its own type, and the default port', () => {
    const doc = JSON.parse(run(['context', '--node', 'cli/io/lock-store', '--json']).stdout) as ContextDoc;
    const aspect = doc.aspects.find((a) => a.id === 'atomic-write-contract');
    expect(aspect).toBeDefined();
    const kinds = aspect!.channels.map((c) => c.kind).sort();
    expect(kinds).toEqual(['own-type', 'port']);
    const portChannel = aspect!.channels.find((c) => c.kind === 'port');
    expect(portChannel!.origin).toBe('port:default@cli/io/atomic-write');
  });

  it('6: core/check is NOT bound by atomic-write-contract — the port reaches it, the when filter excludes it', () => {
    const doc = JSON.parse(run(['context', '--node', 'cli/core/check', '--json']).stdout) as ContextDoc;
    const aspect = doc.aspects.find((a) => a.id === 'atomic-write-contract');
    expect(aspect).toBeUndefined();
  });

  it('7: no yg-node.yaml under the model mentions consumes: or write-atomic any more, except the historical log entry', () => {
    const modelRoot = path.join(REPO_ROOT, '.yggdrasil', 'model');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
          continue;
        }
        if (entry === 'log.md') continue; // history is append-only and hash-guarded — never grepped for drift
        if (!entry.endsWith('.yaml')) continue;
        const text = readFileSync(full, 'utf-8');
        const lines = text.split('\n');
        lines.forEach((line, i) => {
          if (line.includes('consumes:') || line.includes('write-atomic')) {
            hits.push(`${path.relative(REPO_ROOT, full)}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    };
    walk(modelRoot);
    expect(hits).toEqual([]);
  });
});
