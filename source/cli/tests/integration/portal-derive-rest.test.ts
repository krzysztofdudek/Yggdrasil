import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPortalData } from '../../src/portal/extract.js';
import { loadPortalGraph, walkPortalFiles, scanPortalSuppressions } from '../../src/portal/engine-api.js';
import { buildSuppressions, buildHubs, buildResidue, buildWorklist } from '../../src/portal/derive-rest.js';
import { buildBoundary } from '../../src/portal/derive-boundary.js';
import type {
  PortalData,
  PortalNode,
  BoundaryInput,
  SuppressionMarkerInput,
} from '../../src/portal/contract.js';
import type { CheckResult, CheckIssue } from '../../src/core/check.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The REAL repo root (real .yggdrasil/ graph + real source).
const REPO_ROOT = path.resolve(__dirname, '../../../..');

// Hubs, residue, the worklist, and the LIVE boundary, on the REAL repo. The boundary +
// suppression inventory are now produced by the facade (the single engine seam): the
// boundary is computed live (never UNKNOWN on a parseable repo) and the suppression
// inventory is populated. The pure builders are branch-covered directly below with
// synthetic inputs (no fabricated PortalData).

describe('portal rest derivation (hubs / residue / worklist / boundary) — real repo', () => {
  let data: PortalData;

  beforeAll(async () => {
    data = await extractPortalData(REPO_ROOT, { writeEnabled: false });
  }, 180_000);

  it('cli/tests/unit/cli/general leads fan-out at 28, ahead of cli/core/fill at 25 and cli/core/check at 24', () => {
    // The tie this test used to pin (cli/core/fill and cli/tests/unit/cli/general
    // both at 24, alphabetical order breaking it) is gone: the check command's
    // own unit-test umbrella (cli/tests/unit/cli/general) picked up three more
    // relations — `uses` edges to cli/progressive-preflight, cli/progressive-scope-resolve
    // and cli/core/progressive-scope (whose pair-key helper the resolver's own
    // unit test builds its expectations with), added alongside those unit tests
    // — taking it out ahead of the rest on its own, no tie-break needed. It sits
    // at 28 since the outside-changes label test began asserting against
    // cli/core/check-codes' real code set rather than a hand-listed copy.
    // Below it, the tie that used to sit at 24 has been broken: cli/core/fill
    // declared its own `calls` edge to cli/core/progressive-scope when the fill
    // stage began deciding which reviewer work a measured change is accountable
    // for — and, at closure, which unbought rule counts as settled — both keyed
    // by the pair identity that engine defines. That took it from 24 to 25, out
    // ahead of cli/core/check (24, which declared the same edge when it began
    // accepting a change scope).
    //
    // Below those three, 23 is now a TIE. cli/entry joined it when the CLI
    // gained a command for accepting a proposed graph into a repository: the
    // entry point declares an edge to every command it registers, so each new
    // command moves this one node's fan-out by exactly one, and this one took
    // it from 22 to 23 — level with cli/portal/engine-api, which is itself
    // unchanged. The ranking breaks the tie by path, so cli/entry takes the
    // index. Only the FIRST half of a tie is pinned by index here;
    // engine-api is pinned by path for the same reason aspect-test below is —
    // anchoring the far side of a tie to a fixed slot is the brittle anchor a
    // past dogfood entry recorded against this very file.
    expect(data.hubs.fanOut.length).toBeGreaterThan(0);
    expect(data.hubs.fanOut[0].path).toBe('cli/tests/unit/cli/general');
    expect(data.hubs.fanOut[0].count).toBe(28);
    expect(data.hubs.fanOut[1].path).toBe('cli/core/fill');
    expect(data.hubs.fanOut[1].count).toBe(25);
    expect(data.hubs.fanOut[2].path).toBe('cli/core/check');
    expect(data.hubs.fanOut[2].count).toBe(24);
    expect(data.hubs.fanOut[3].path).toBe('cli/entry');
    expect(data.hubs.fanOut[3].count).toBe(23);
    const engineApi = data.hubs.fanOut.find((h) => h.path === 'cli/portal/engine-api');
    expect(engineApi).toBeDefined();
    expect(engineApi!.count).toBe(23);
    // Also pins that aspect-test's own extraction (a prior architectural
    // change) still landed it BELOW the leaders, never re-joining the tie by
    // accident. Found by path, not by a fixed index — the nodes between the
    // top and aspect-test in the ranking are unrelated to this change and no
    // more pinned here than they were before, avoiding the brittle-anchor
    // failure mode a past dogfood entry recorded for this same test file.
    const aspectTest = data.hubs.fanOut.find((h) => h.path === 'cli/commands/aspect-test');
    expect(aspectTest).toBeDefined();
    expect(aspectTest!.count).toBe(20);
    expect(aspectTest!.count).toBeLessThan(23);
    // descending order invariant.
    for (let i = 1; i < data.hubs.fanOut.length; i++) {
      expect(data.hubs.fanOut[i - 1].count).toBeGreaterThanOrEqual(data.hubs.fanOut[i].count);
    }
  });

  it('fan-in hubs are ranked and the heaviest is a shared utility/store node', () => {
    expect(data.hubs.fanIn.length).toBeGreaterThan(0);
    for (let i = 1; i < data.hubs.fanIn.length; i++) {
      expect(data.hubs.fanIn[i - 1].count).toBeGreaterThanOrEqual(data.hubs.fanIn[i].count);
    }
  });

  it('the worklist reports high fan-out only for a node over its OWN allowance, so this repo — where every such node declares one — has none', () => {
    // The check compares a node's declared relation count against its own
    // max_direct_relations when it sets one, and against the repository default
    // otherwise. Every node here that exceeds the default carries an explicit
    // allowance equal to its exact count, each with a written reason for why the
    // count describes the work rather than a tangle — so no node is over its own
    // limit and the worklist has nothing to report.
    //
    // Asserting the group's ABSENCE is what makes this test worth having: the
    // moment a node grows past its own stated allowance, or gains relations
    // without its reason being revisited, the group reappears here and this
    // fails. A count pinned to whichever node happens to be over today would
    // instead have to be edited every time the graph legitimately changed,
    // which teaches the reader nothing.
    expect(data.worklist.find((w) => w.rule === 'high-fan-out')).toBeUndefined();
  });

  it('the boundary is LIVE (computed, never UNKNOWN) on the real parseable repo', () => {
    expect(data.boundary.unknown).toBe(false);
    // A green repo has no undeclared (phantom) dependency and no architecture-forbidden
    // edge; declared-only edges (declared relations with no static code backing) are
    // expected and surfaced — never hidden.
    expect(data.boundary.phantom).toEqual([]);
    expect(data.boundary.forbiddenType).toEqual([]);
    expect(Array.isArray(data.boundary.declaredOnly)).toBe(true);
  });

  it('the residue never hides a genuinely-no-rule source node (universal honesty invariant, robust to coverage level)', () => {
    // Asserted as a UNIVERSAL invariant rather than by pinning any one node. As coverage
    // closes (rule-bearing aspects attach to more source-owning types), the set of genuinely-
    // no-rule source nodes shrinks — and may legitimately trend all the way to EMPTY. The old
    // pin that named `scripts` here rotted the instant `scripts` gained a rule, so it is gone.
    // What MUST hold at every coverage level is that the residue never HIDES a source node
    // that carries no rule: for every derived node that owns source, it is either surfaced in
    // the no-rule residue, OR it carries at least one effective aspect (a rule reaches it), OR
    // its mapped source was just edited (`fresh`) and it is therefore surfaced as `unverified`
    // — a stronger, more-visible state than no-rule, never a silent green. This is strictly
    // stronger than the old single-node pin and cannot be defeated by the coverage closing.
    const byPath = new Map(data.nodes.map((n) => [n.path, n]));
    const noRule = new Set(data.residue.noRuleNodes);
    for (const n of data.nodes) {
      if (n.mapping.length === 0) continue; // a node with no source cannot be a no-rule SOURCE node
      const surfaced = noRule.has(n.path) || n.effectiveAspects.length > 0 || n.fresh;
      expect(surfaced, `source node "${n.path}" (state=${n.state}) is hidden: absent from the residue, carries no rule, and is not fresh`).toBe(true);
    }
    // The general residue invariant is KEPT: every node the residue calls no-rule reads
    // state==='no-rule' in its own node detail — the residue can never mislabel a node.
    for (const p of data.residue.noRuleNodes) {
      expect(byPath.get(p)!.state).toBe('no-rule');
    }
  });
});

// ── Suppression inventory — form + errs-under risk, off a REAL fixture scan ────
//
// `portal-suppress-forms` is a real, working project (its own `.yggdrasil/` graph +
// real source, loaded and scanned exactly like the portal would) with one node
// (`code`, mapping the whole `src/` tree) whose architecture type carries two
// deterministic aspects: `no-console` (errs: under) and `no-todo` (no errs label).
// Each of its four files carries a DIFFERENT waiver shape, proving `form` and the
// `errs-under` risk resolution off the facade's real scan+adapt path — never a
// synthetic `SuppressionMarkerInput[]` literal.
const FIXTURES_ROOT = path.resolve(__dirname, '../fixtures');

/** Load + scan one fixture's live suppression inventory via the SAME facade the
 *  portal pipeline calls (`scanPortalSuppressions` in engine-api.ts) — never a
 *  hand-built report. Returns both the adapted markers and the scan's raw
 *  `totalMarkers`, so callers can pin `counts.suppressionMarkers` (extract.ts
 *  fills it straight from `totalMarkers`) against the SAME live scan the
 *  adapted marker list comes from, instead of a synthetic count. */
async function scanFixture(
  name: string,
): Promise<{ markers: SuppressionMarkerInput[]; totalMarkers: number }> {
  const root = path.join(FIXTURES_ROOT, name);
  const graph = await loadPortalGraph(root);
  const repoFiles = await walkPortalFiles(root);
  return scanPortalSuppressions(graph, root, repoFiles);
}

describe('portal suppression inventory — real fixture (form + errs-under risk)', () => {
  it('suppression inventory carries form and the errs-under risk', async () => {
    const { markers, totalMarkers } = await scanFixture('portal-suppress-forms');
    const byFile = Object.fromEntries(markers.map((m) => [m.file, m]));
    // src/whole.ts: an unclosed disable(no-todo) at the file head — the sanctioned
    // whole-file waiver. Classified `file-level`, so it is NO-RISK: file-level is
    // sanctioned, never `unbounded`.
    expect(byFile['src/whole.ts']).toMatchObject({ form: 'file' });
    expect(byFile['src/whole.ts'].risk).toBeUndefined();
    // src/range.ts: a CLOSED disable(no-todo)/enable(no-todo) pair — a bounded block,
    // never open, so it is no-risk too.
    expect(byFile['src/range.ts']).toMatchObject({ form: 'range' });
    expect(byFile['src/range.ts'].risk).toBeUndefined();
    // src/line.ts: a single-line marker on a known, non-draft, non-under aspect — clean.
    expect(byFile['src/line.ts']).toMatchObject({ form: 'line' });
    expect(byFile['src/line.ts'].risk).toBeUndefined();
    // src/under.ts: a single-line marker naming `no-console` (errs: under) — the
    // footgun risk: it waives a check that cannot itself false-alarm.
    expect(byFile['src/under.ts']).toMatchObject({ form: 'line', risk: 'errs-under' });
    // `counts.suppressionMarkers` (extract.ts) is filled straight from the scan's raw
    // `totalMarkers`, NOT from `markers.length` — this fixture proves the two diverge:
    // range.ts's disable/enable pair is TWO raw markers but adapts into ONE `form: 'range'`
    // entry above. Pinning totalMarkers > markers.length here is the only thing standing
    // between `counts.suppressionMarkers` and silently regressing to 0 (or to markers.length,
    // undercounting every closed range) with no test failing.
    expect(markers.length).toBe(4);
    expect(totalMarkers).toBe(5);
  });
});

// ── Pure-builder branch coverage (synthetic inputs, real builder functions) ───

describe('portal rest builders — honest branches', () => {
  it('buildBoundary(null) is UNKNOWN; a populated input is clean/false and deduped+sorted', () => {
    expect(buildBoundary(null).unknown).toBe(true);

    const input: BoundaryInput = {
      phantom: [
        { source: 'b', target: 'x' },
        { source: 'a', target: 'y' },
        { source: 'a', target: 'y' }, // duplicate
      ],
      declaredOnly: [],
      forbiddenType: [{ source: 'c', target: 'z' }],
    };
    const b = buildBoundary(input);
    expect(b.unknown).toBe(false);
    // deduped to 2, sorted by source then target.
    expect(b.phantom).toEqual([
      { source: 'a', target: 'y' },
      { source: 'b', target: 'x' },
    ]);
    expect(b.forbiddenType).toEqual([{ source: 'c', target: 'z' }]);
  });

  it('buildSuppressions carries the risk flag and form, and sorts by file then line', () => {
    const markers: SuppressionMarkerInput[] = [
      { file: 'src/b.ts', line: 10, aspectId: 'a1', reason: 'r', form: 'line' },
      { file: 'src/a.ts', line: 30, aspectId: '*', reason: 'silence all', risk: 'wildcard', form: 'file' },
      { file: 'src/a.ts', line: 5, aspectId: 'a2', reason: 'r2', risk: 'unbounded', form: 'range' },
    ];
    const out = buildSuppressions(markers);
    expect(out.map((s) => `${s.file}:${s.line}`)).toEqual(['src/a.ts:5', 'src/a.ts:30', 'src/b.ts:10']);
    const wildcard = out.find((s) => s.aspectId === '*')!;
    expect(wildcard.risk).toBe('wildcard');
    expect(wildcard.form).toBe('file');
    expect(out.filter((s) => s.risk).length).toBe(2);
  });

  it('buildHubs omits zero-degree nodes and ranks descending', () => {
    const nodes = [
      mkNode('n1', 3, 1),
      mkNode('n2', 0, 0),
      mkNode('n3', 5, 2),
    ];
    const hubs = buildHubs(nodes);
    expect(hubs.fanOut.map((h) => h.path)).toEqual(['n3', 'n1']);
    expect(hubs.fanOut[0].count).toBe(5);
    // n2 (zero degree) is omitted from both lists.
    expect(hubs.fanOut.find((h) => h.path === 'n2')).toBeUndefined();
    expect(hubs.fanIn.find((h) => h.path === 'n2')).toBeUndefined();
  });

  it('buildResidue collects only mapped no-rule nodes and sorts uncovered files', () => {
    const nodes = [
      { ...mkNode('keep', 0, 0), state: 'no-rule' as const, mapping: ['f.ts'] },
      { ...mkNode('drop-empty', 0, 0), state: 'no-rule' as const, mapping: [] },
      { ...mkNode('verified-node', 0, 0), state: 'verified' as const, mapping: ['g.ts'] },
    ];
    const residue = buildResidue(nodes, ['z.ts', 'a.ts']);
    expect(residue.noRuleNodes).toEqual(['keep']);
    expect(residue.uncoveredFiles).toEqual(['a.ts', 'z.ts']);
  });

  it('buildWorklist reuses groupIssues — empty issues yield an empty worklist', () => {
    const check = { issues: [] } as unknown as CheckResult;
    expect(buildWorklist(check)).toEqual({ groups: [], coverage: [] });
  });
});

function mkNode(p: string, outDeg: number, inDeg: number): PortalNode {
  return {
    path: p,
    name: p,
    type: 'module',
    parent: null,
    mapping: [],
    mappingEntryCount: 0,
    sourceFileCount: 0,
    isTest: false,
    checked: false,
    fresh: false,
    state: 'no-rule',
    rollupState: 'no-rule',
    effectiveAspects: [],
    notApplicable: [],
    relationsOut: Array.from({ length: outDeg }, (_, i) => ({ target: `t${i}`, type: 'calls' })),
    relationsIn: Array.from({ length: inDeg }, (_, i) => ({ source: `s${i}`, type: 'calls' })),
    suppressions: [],
    log: [],
  };
}

describe('portal rest builders — additional honest branches', () => {
  it('buildBoundary surfaces declaredOnly edges (sorted, deduped)', () => {
    const b = buildBoundary({
      phantom: [],
      declaredOnly: [
        { source: 'z', target: 'a' },
        { source: 'a', target: 'b' },
      ],
      forbiddenType: [],
    });
    expect(b.unknown).toBe(false);
    expect(b.declaredOnly).toEqual([
      { source: 'a', target: 'b' },
      { source: 'z', target: 'a' },
    ]);
  });

  it('buildWorklist maps grouped issues to rule/why/fix/members (deduped, sorted)', () => {
    const check = {
      issues: [
        {
          severity: 'error',
          code: 'unverified',
          rule: 'unverified',
          nodePath: 'node-b',
          messageData: { what: 'w', why: 'shared why', next: 'yg check --approve' },
        },
        {
          severity: 'error',
          code: 'unverified',
          rule: 'unverified',
          nodePath: 'node-a',
          messageData: { what: 'w', why: 'shared why', next: 'yg check --approve' },
        },
      ],
    } as unknown as CheckResult;
    const { groups } = buildWorklist(check);
    expect(groups).toHaveLength(1);
    expect(groups[0].rule).toBe('unverified');
    expect(groups[0].severity).toBe('error');
    expect(groups[0].why).toBe('shared why');
    expect(groups[0].fix).toBe('yg check --approve');
    // sorted, deduped — mirrors groupIssues' own nodePath sort.
    expect(groups[0].members.map((m) => m.node)).toEqual(['node-a', 'node-b']);
  });

  it('buildWorklist splits severities, mirrors members, and partitions coverage', () => {
    const mk = (over: Partial<CheckIssue>): CheckIssue => ({
      severity: 'error', code: 'unverified', rule: 'unverified',
      messageData: { what: 'w', why: 'shared why', next: 'yg check --approve' }, ...over,
    } as CheckIssue);
    const issues = [
      mk({ nodePath: 'a', aspectId: 'x',
           messageData: { what: 'w\nextra detail line', why: 'shared why', next: 'yg check --approve' } }),
      mk({ nodePath: 'a', aspectId: 'y' }),
      mk({ severity: 'warning', nodePath: 'a', aspectId: 'z' }),                    // same code, other severity
      mk({ code: 'aspect-violation-enforced', rule: 'enforced', aspectId: 'r',
           unitKey: 'file:src/f.ts',
           // A trailing whitespace-only tail line must be trimmed then dropped (Minor 1),
           // not survive as a fake "non-empty" continuation line.
           messageData: { what: 'head\nsrc/f.ts:3 detail\n   \nsrc/f.ts:9 detail2', why: 'w2', next: 'n2' } }),
      // No aspectId on either member: exercises the `what`-first-line fallback (Finding 2)
      // AND divergent per-member why/next (Minor 3d) on the SAME group.
      mk({ code: 'log-entry-missing', rule: 'log-entry-missing', nodePath: 'b',
           messageData: { what: 'no log for node\nextra internal detail', why: 'why-b', next: 'yg log add --node b' } }),
      mk({ code: 'log-entry-missing', rule: 'log-entry-missing', nodePath: 'c',
           messageData: { what: 'no log for node c', why: 'why-c', next: 'yg log add --node c' } }),
      // Repo-level (no nodePath, no unitKey): exercises the full-`what` fallback (Finding 1).
      mk({ code: 'lock-invalid', rule: 'lock-invalid',
           messageData: { what: 'Lock file corrupt \nDetails: bad json at line 4   ', why: 'w3', next: 'n3' } }),
      mk({ code: 'unmapped-files', messageData: { what: 'w', why: 'cov why', next: 'cov fix' },
           uncoveredFiles: ['src/u.ts'] }),
      // A second coverage code (warning severity) — Minor 3c: both blocks must surface.
      mk({ code: 'uncovered-advisory', severity: 'warning',
           messageData: { what: 'w', why: 'adv why', next: 'adv fix' },
           uncoveredFiles: ['src/v.ts'] }),
    ];
    const { groups, coverage } = buildWorklist({ issues } as unknown as CheckResult);

    // (Minor 3a) Real priority-ranked order — errors first, never sorted away by a `.sort()`
    // that would let a warnings-before-errors bug through.
    expect(groups.map((g) => g.code)).toEqual([
      'lock-invalid', 'log-entry-missing', 'unverified', 'aspect-violation-enforced', 'unverified',
    ]);
    expect(groups.map((g) => g.severity)).toEqual(['error', 'error', 'error', 'error', 'warning']);

    const unverifiedGroups = groups.filter((g) => g.code === 'unverified');
    expect(unverifiedGroups).toHaveLength(2);                       // severity split
    expect(unverifiedGroups.map((g) => g.severity).sort()).toEqual(['error', 'warning']);
    const err = unverifiedGroups.find((g) => g.severity === 'error')!;
    expect(err.members.map((m) => m.aspectId).sort()).toEqual(['x', 'y']);

    const refusal = groups.find((g) => g.code === 'aspect-violation-enforced')!;
    expect(refusal.aspectId).toBe('r');
    expect(refusal.members[0]).toMatchObject({
      file: 'src/f.ts',
      whatLines: ['src/f.ts:3 detail', 'src/f.ts:9 detail2'],
    });
    expect(refusal.members[0].what).toBeUndefined();  // FULL_WHAT code: whatLines, never what
    expect(refusal.fileCount).toBe(1);

    expect(groups.some((g) => g.code === 'unmapped-files')).toBe(false);     // partitioned out
    expect(groups.some((g) => g.code === 'uncovered-advisory')).toBe(false); // partitioned out
    // (Minor 3c) Both coverage codes surfaced, each with its own severity.
    expect(coverage).toEqual([
      { code: 'unmapped-files', severity: 'error', files: ['src/u.ts'], why: 'cov why', fix: 'cov fix' },
      { code: 'uncovered-advisory', severity: 'warning', files: ['src/v.ts'], why: 'adv why', fix: 'adv fix' },
    ]);

    // (Minor 3b) non-FULL_WHAT gate: a MULTI-LINE `what` on a non-FULL_WHAT code never
    // becomes whatLines (the fixture's old single-line 'w' made this assertion vacuous).
    const memberX = err.members.find((m) => m.aspectId === 'x')!;
    expect(memberX.whatLines).toBeUndefined();
    // memberX carries an aspectId, so `what` never fires either — aspectId already
    // identifies it, and `what`/`aspectId` never both populate on the same member.
    expect(memberX.what).toBeUndefined();
    expect(err.members.every((m) => m.whatLines === undefined)).toBe(true);

    // (Minor 3d) Divergent per-member why/next, synthetically forced (previously only
    // incidental via the real-repo path).
    const logGroup = groups.find((g) => g.code === 'log-entry-missing')!;
    expect(logGroup.divergentWhy).toBe(true);
    expect(logGroup.divergentNext).toBe(true);
    const memberB = logGroup.members.find((m) => m.node === 'b')!;
    const memberC = logGroup.members.find((m) => m.node === 'c')!;
    expect(memberB.why).toBe('why-b');
    expect(memberB.next).toBe('yg log add --node b');
    expect(memberC.why).toBe('why-c');
    expect(memberC.next).toBe('yg log add --node c');

    // (Minor 3e / Finding 2) subject-bearing member, no aspectId: `what` is the FIRST
    // line only (the second line, 'extra internal detail', is dropped).
    expect(memberB.what).toBe('no log for node');
    expect(memberB.aspectId).toBeUndefined();

    // (Minor 3e / Finding 1) repo-level member (no node, no file): `what` is the FULL
    // text, every line, trailing whitespace trimmed per line but no line dropped.
    const lockGroup = groups.find((g) => g.code === 'lock-invalid')!;
    expect(lockGroup.members[0].node).toBeUndefined();
    expect(lockGroup.members[0].file).toBeUndefined();
    expect(lockGroup.members[0].what).toBe('Lock file corrupt\nDetails: bad json at line 4');
  });
});
