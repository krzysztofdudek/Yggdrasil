import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAdviseCommand } from '../../../src/cli/advise.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import {
  buildNominations,
  parseFamilyCandidates,
  CANDIDATES_SHARD_SCHEMA,
  SUPPORTED_CANDIDATES_V,
} from '../../../src/core/advise-nominations.js';
import { CACHE_SCHEMA_VERSION } from '../../../src/relations/facts-cache.js';
import { ruleHashFor } from '../../../src/core/pair-inputs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');
const TYPE_LEVEL_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');
const distExists = existsSync(BIN_PATH);

// The always-live nomination the fixture is rigged to produce (a far-past
// review_by injected onto an existing aspect).
const LIVE_ID = 'overdue-review-by:requires-logging';
const HEX64 = /^[0-9a-f]{64}$/;

function run(args: string[], cwd: string, env?: Record<string, string>) {
  const r = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

/** Count raw C0 (except LF) / DEL / C1 control bytes in a string — 0 means clean. */
function rawControlBytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c < 0x20 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f)) n += 1;
  }
  return n;
}

function readRegister(projectRoot: string): string[] {
  const p = path.join(projectRoot, '.yggdrasil', 'advise-decisions.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').split('\n').filter((l) => l.length > 0);
}

describe('registerAdviseCommand', () => {
  it('registers `yg advise` with its dismiss, defer and import subcommands', () => {
    const program = new Command();
    registerAdviseCommand(program);
    const advise = program.commands.find((c) => c.name() === 'advise');
    expect(advise).toBeDefined();
    const subs = (advise!.commands ?? []).map((c) => c.name()).sort();
    // The two acts a user records against an item, plus the one that brings
    // another tool's proposals in for them to act on.
    expect(subs).toEqual(['defer', 'dismiss', 'import']);
  });
});

describe.skipIf(!distExists)('yg advise dismiss / defer (spawned)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-advise-e2e-'));
    cpSync(FIXTURE, projectRoot, { recursive: true });
    appendFileSync(
      path.join(projectRoot, '.yggdrasil', 'aspects', 'requires-logging', 'yg-aspect.yaml'),
      '\nreview_by: 2020-01-01\n',
      'utf-8',
    );
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('dismiss <id> --reason appends exactly one line bound to the current evidence hash', () => {
    const { status } = run(['advise', 'dismiss', LIVE_ID, '--reason', 'reviewed, keeping'], projectRoot);
    expect(status).toBe(0);

    const lines = readRegister(projectRoot);
    expect(lines).toHaveLength(1);
    const decision = JSON.parse(lines[0]);
    expect(decision.id).toBe(LIVE_ID);
    expect(decision.action).toBe('dismiss');
    expect(decision.reason).toBe('reviewed, keeping');
    expect(decision.evidenceHash).toMatch(HEX64);
    expect(decision.v).toBe(1);
  });

  it('defer <id> --until <date> --reason appends a defer line with the until date', () => {
    const { status } = run(
      ['advise', 'defer', LIVE_ID, '--until', '2030-01-01', '--reason', 'revisit next quarter'],
      projectRoot,
    );
    expect(status).toBe(0);

    const lines = readRegister(projectRoot);
    expect(lines).toHaveLength(1);
    const decision = JSON.parse(lines[0]);
    expect(decision.action).toBe('defer');
    expect(decision.until).toBe('2030-01-01');
    expect(decision.reason).toBe('revisit next quarter');
  });

  it('defer with a mis-shaped --until is rejected and writes nothing', () => {
    const { status } = run(
      ['advise', 'defer', LIVE_ID, '--until', '2030-13-40', '--reason', 'bad date'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(readRegister(projectRoot)).toHaveLength(0);
  });

  it('dismiss with an empty --reason is rejected and writes nothing', () => {
    const { status } = run(['advise', 'dismiss', LIVE_ID, '--reason', ''], projectRoot);
    expect(status).toBe(1);
    expect(readRegister(projectRoot)).toHaveLength(0);
  });

  it('dismiss of an unknown id is rejected, names the known ids, and writes nothing', () => {
    const { status, stderr } = run(
      ['advise', 'dismiss', 'overdue-review-by:does-not-exist', '--reason', 'x'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toContain(LIVE_ID);
    expect(readRegister(projectRoot)).toHaveLength(0);
  });
});

// ── Task 5: the bare `yg advise` feed — two sections, precedence, cap, --all/--ids ──

/** Add an orphaned/dead aspect directory with a real rule source. */
function writeAspect(root: string, id: string, body: string): void {
  const dir = path.join(root, '.yggdrasil', 'aspects', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'yg-aspect.yaml'),
    `name: ${id}\nid: ${id}\ndescription: ${body}\nreviewer:\n  type: llm\n`,
    'utf-8',
  );
  writeFileSync(path.join(dir, 'content.md'), `${body}\n`, 'utf-8');
}

describe.skipIf(!distExists)('yg advise — Step 1: sections, precedence, provenance (spawned)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-advise-s1-'));
    cpSync(FIXTURE, projectRoot, { recursive: true });
    // overdue review_by
    appendFileSync(
      path.join(projectRoot, '.yggdrasil', 'aspects', 'requires-logging', 'yg-aspect.yaml'),
      '\nreview_by: 2020-01-01\n',
      'utf-8',
    );
    // a wildcard suppress marker in a mapped source file
    appendFileSync(
      path.join(projectRoot, 'src', 'auth', 'auth.controller.ts'),
      '\n// yg-suppress(*) test wildcard waiver\n',
      'utf-8',
    );
    // an orphaned aspect (referenced nowhere)
    writeAspect(projectRoot, 'orphan-x', 'Referenced by nothing.');
    // a dead-attach aspect: referenced on a node but via a never-matching when
    writeAspect(projectRoot, 'dead-x', 'Referenced but attaches nowhere.');
    appendFileSync(
      path.join(projectRoot, '.yggdrasil', 'model', 'auth', 'yg-node.yaml'),
      '\naspects:\n  - id: dead-x\n    when:\n      path: "no/such/nonexistent/**"\n',
      'utf-8',
    );
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('renders Attention + Nominations, ordered by class precedence, exit 0', () => {
    const { status, stdout } = run(['advise'], projectRoot);
    expect(status).toBe(0);

    // Attention: the C7 tunnel aggregate line with a real, positive count.
    expect(stdout).toContain('Attention');
    const m = stdout.match(
      /(\d+) dependencies jump across distant parts of the architecture — run yg structure to see them/,
    );
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(1);

    // Nominations: suppress-anomaly ABOVE dead-attach ABOVE orphaned ABOVE overdue.
    expect(stdout).toContain('Nominations');
    const iSuppress = stdout.indexOf('is risky (wildcard)');
    const iDead = stdout.indexOf('has a rule source but is effective on zero nodes');
    const iOrphan = stdout.indexOf('is defined but not referenced');
    const iOverdue = stdout.indexOf('is past its review_by date');
    expect(iSuppress).toBeGreaterThanOrEqual(0);
    expect(iDead).toBeGreaterThan(iSuppress);
    expect(iOrphan).toBeGreaterThan(iDead);
    expect(iOverdue).toBeGreaterThan(iOrphan);
  });

  it('quotes the suppress evidence with provenance and ends every NEXT with the approval note', () => {
    const { stdout } = run(['advise'], projectRoot);
    // Provenance-quoted marker (RZ-5 injection hygiene): repo text is DATA, not prose.
    expect(stdout).toMatch(/marker '\*' at src\/auth\/auth\.controller\.ts:\d+/);
    expect(stdout).toContain('suppress reason: "test wildcard waiver"');
    // Every nomination names a human action requiring approval.
    const approvals = stdout.match(/requires your approval/g) ?? [];
    const nominations = stdout.match(/ {4}(marker|Its attach|Orphaned aspects|A review_by)/g) ?? [];
    expect(approvals.length).toBeGreaterThanOrEqual(nominations.length);
    expect(approvals.length).toBeGreaterThanOrEqual(4);
  });
});

describe.skipIf(!distExists)('yg advise — Step 2: cap, --all, --ids (spawned)', () => {
  let projectRoot: string;
  const MARKERS = 12;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-advise-s2-'));
    cpSync(FIXTURE, projectRoot, { recursive: true });
    // 12 distinct wildcard suppress markers → 12 suppress-anomaly nominations.
    let block = '\n';
    for (let i = 0; i < MARKERS; i++) {
      block += `// yg-suppress(*) waiver ${i}\nexport const _w${i} = ${i};\n`;
    }
    appendFileSync(path.join(projectRoot, 'src', 'auth', 'auth.controller.ts'), block, 'utf-8');
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('bare feed caps at 10 and reports how many the cap hid', () => {
    const { status, stdout } = run(['advise'], projectRoot);
    expect(status).toBe(0);
    const shown = (stdout.match(/is risky \(wildcard\)/g) ?? []).length;
    expect(shown).toBe(10);
    expect(stdout).toMatch(/and \d+ more nomination/);
    expect(stdout).toContain(`${MARKERS - 10} more`);
    // Pinned to the exact pre-existing footer wording: `yg advise` output is
    // unconditional (not gated by `coverage.type_level`), so it is held to the
    // same flag-off byte-identity contract as every other command — this exact
    // string must never drift without a matching entry in CHANGELOG.md.
    expect(stdout).toContain('more nominations not shown — run yg advise --all to see them all.');
  });

  it('--all removes the cap and shows every nomination', () => {
    const { status, stdout } = run(['advise', '--all'], projectRoot);
    expect(status).toBe(0);
    const shown = (stdout.match(/is risky \(wildcard\)/g) ?? []).length;
    expect(shown).toBe(MARKERS);
  });

  it('--ids prints the stable <classKey>:<key> under each nomination', () => {
    const { status, stdout } = run(['advise', '--ids'], projectRoot);
    expect(status).toBe(0);
    expect(stdout).toMatch(/id: suppress-anomaly:src\/auth\/auth\.controller\.ts:\d+/);
  });
});

// ── Task 5 fixes: id-surface injection hygiene + attention/structure consistency ──

/**
 * Write a drill-results sidecar with a MISS whose repo-derived `case` label — which
 * flows verbatim into the stable nomination id — carries a bell, an ANSI escape,
 * and a raw newline. A POSIX-legal but hostile label; the id must reach every
 * opt-in surface neutralized.
 */
function writeHostileDrillCase(projectRoot: string): string {
  const ESC = String.fromCharCode(27); // ANSI escape
  const BEL = String.fromCharCode(7); // bell — a control byte chalk never emits
  const caseLabel = `violates-x/needs${BEL}${ESC}\naudit`;
  // The drill-MISS nomination now only surfaces for a case that is REAL in the
  // aspect's current in-repo corpus (orphaned telemetry is dropped). Stage the
  // matching case file on disk so the hostile label reaches the id surface through
  // the real corpus-membership gate — a `.ts` case under drills/violates-x/ whose
  // extension-stripped, corpus-relative label is exactly `caseLabel`.
  const caseAbs = path.join(
    projectRoot,
    '.yggdrasil',
    'aspects',
    'requires-audit',
    'drills',
    `${caseLabel}.ts`,
  );
  mkdirSync(path.dirname(caseAbs), { recursive: true });
  writeFileSync(caseAbs, 'export const x = 1;\n', 'utf-8');
  const line = {
    v: 1,
    ts: '2026-07-01T00:00:00.000Z',
    aspect: 'requires-audit',
    case: caseLabel,
    expect: 'refused',
    got: 'satisfied',
    src: 'dev',
    corpus: 'dev',
    caseHash: 'c'.repeat(64),
    ruleHash: '0'.repeat(64),
    kind: 'llm',
  };
  writeFileSync(
    path.join(projectRoot, '.yggdrasil', '.drill-results.jsonl'),
    JSON.stringify(line) + '\n',
    'utf-8',
  );
  return `drill-miss:requires-audit/${caseLabel}`;
}

describe.skipIf(!distExists)('yg advise agrees with yg check on a rule enforced only through type coverage (spawned)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-advise-typelevel-'));
    cpSync(TYPE_LEVEL_FIXTURE, projectRoot, { recursive: true });
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('never nominates dead-attach for a rule yg check reports enforced through a type with no real component node', () => {
    // Ground truth from yg check: type 'forked' (tests/fixtures/type-level-engine)
    // has no real component node anywhere — src/forked/f.ts is enforced by its
    // architecture type alone — yet forked-own-rule is live there.
    const checked = run(['check'], projectRoot);
    // The (optional) trailing ", N unverified" is this fixture's own honest
    // reporting of a pair that has not been approved here — irrelevant to
    // what this test actually pins, which is that the rule is listed as
    // effective (Enforced) on this nodeless type at all.
    expect(checked.stdout).toMatch(/'forked'[\s\S]*?Enforced: forked-own-rule \(1(?:, \d+ unverified)?\)/);

    // yg advise classifies the SAME graph for its own dead-attach nomination. It
    // must reach the same verdict yg check just did, not report the identical
    // rule as effective nowhere and offer to park it as draft.
    const advised = run(['advise', '--all'], projectRoot);
    expect(advised.status).toBe(0);
    expect(advised.stdout).not.toContain(
      "Aspect 'forked-own-rule' has a rule source but is effective on zero nodes.",
    );
  });
});

describe.skipIf(!distExists)('yg advise nominates a risky marker on every file a marker can live on (spawned)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-advise-waiverhosts-'));
    cpSync(TYPE_LEVEL_FIXTURE, projectRoot, { recursive: true });
    // Adds architecture type 'pics' (matches src/pics/**, attaches the LLM
    // per-file rule prose-rule) and a real text subject, src/pics/readme.md —
    // a type-covered file whose extension (`.md`) the suppression scan's
    // noise filter would otherwise drop as documentation prose. A `.ts`
    // subject can never exercise that filter (it was never noise to begin
    // with), so this variant is what makes the type-covered case below
    // actually depend on the type-coverage exemption rather than passing
    // for an unrelated reason.
    cpSync(path.join(TYPE_LEVEL_FIXTURE, 'variants', 'binary-subject'), projectRoot, { recursive: true });

    // A live marker is honored on three different kinds of file, and `yg advise`
    // must nominate a risky one on all three: a type-covered file with no
    // owning component (src/pics/readme.md, type 'pics'), and two files the
    // real 'owned' node maps directly — one under `.yggdrasil/` (a repo walk
    // prunes that whole directory) and one a `.gitignore` excludes (an exact
    // mapping entry is reviewed regardless of ignore status). None of the
    // three would ever surface in an ordinary git-tracked-file walk; they are
    // live waiver sites because the deterministic runner reads a node's mapping
    // and the type-coverage lattice directly, never through that walk.
    const nodeYamlPath = path.join(projectRoot, '.yggdrasil', 'model', 'owned', 'yg-node.yaml');
    const original = readFileSync(nodeYamlPath, 'utf-8');
    const updated = original.replace(
      'mapping:\n  - src/owned/o.ts\n',
      'mapping:\n  - src/owned/o.ts\n  - .yggdrasil/meta/notes.md\n  - generated/g.ts\n',
    );
    if (updated === original) throw new Error(`fixture drift: expected mapping block not found in ${nodeYamlPath}`);
    writeFileSync(nodeYamlPath, updated);

    mkdirSync(path.join(projectRoot, '.yggdrasil', 'meta'), { recursive: true });
    writeFileSync(
      path.join(projectRoot, '.yggdrasil', 'meta', 'notes.md'),
      '# design notes\n\n<!-- yg-suppress(*) waiver on a file mapped under .yggdrasil -->\n',
    );

    writeFileSync(path.join(projectRoot, '.gitignore'), 'generated/\n');
    mkdirSync(path.join(projectRoot, 'generated'), { recursive: true });
    writeFileSync(
      path.join(projectRoot, 'generated', 'g.ts'),
      'export const G = 1;\n// yg-suppress(*) waiver on a gitignored mapped file\n',
    );

    appendFileSync(
      path.join(projectRoot, 'src', 'pics', 'readme.md'),
      '\n<!-- yg-suppress(*) waiver on a type-covered file with no component -->\n',
    );
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('reports "is risky (wildcard)" for the type-covered file, the .yggdrasil/-mapped file, and the gitignored mapped file', () => {
    const { status, stdout } = run(['advise', '--all'], projectRoot);
    expect(status).toBe(0);
    expect(stdout).toMatch(/A suppress marker at '?src\/pics\/readme\.md:\d+'? is risky \(wildcard\)/);
    expect(stdout).toMatch(/A suppress marker at '?\.yggdrasil\/meta\/notes\.md:\d+'? is risky \(wildcard\)/);
    expect(stdout).toMatch(/A suppress marker at '?generated\/g\.ts:\d+'? is risky \(wildcard\)/);
  });
});

describe.skipIf(!distExists)('yg advise — id-surface injection hygiene (spawned)', () => {
  let projectRoot: string;
  let canonicalId: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-advise-idhyg-'));
    cpSync(FIXTURE, projectRoot, { recursive: true });
    canonicalId = writeHostileDrillCase(projectRoot);
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  // NO_COLOR so chalk emits no styling ESC of its own — then every control byte we
  // see could only have come from the injected id, making the assertion exact.
  const noColor = { NO_COLOR: '1' };
  // The rendered (sanitized) form: the three hostile bytes collapse to ONE space.
  const SANITIZED = 'drill-miss:requires-audit/violates-x/needs audit';

  it('--ids renders the id with every control byte neutralized (no rogue byte escapes)', () => {
    const { status, stdout } = run(['advise', '--ids'], projectRoot, noColor);
    expect(status).toBe(0);
    expect(rawControlBytes(stdout)).toBe(0);
    // Still rendered — the bytes are folded to a space, never dropped or line-broken.
    expect(stdout).toContain(`id: ${SANITIZED}`);
  });

  it('the dismiss "known ids" error join neutralizes control bytes in the listed ids', () => {
    const { status, stderr } = run(
      ['advise', 'dismiss', 'no-such-id', '--reason', 'x'],
      projectRoot,
      noColor,
    );
    expect(status).toBe(1);
    expect(rawControlBytes(stderr)).toBe(0);
    expect(stderr).toContain(SANITIZED);
  });

  it('dismiss still resolves the REAL canonical id — sanitizing is render-only', () => {
    // The canonical id keeps its raw bytes; naming it exactly still succeeds and
    // the committed decision stores it verbatim, proving the render-time sanitizer
    // never touched what decisions bind to.
    const { status } = run(['advise', 'dismiss', canonicalId, '--reason', 'reviewed'], projectRoot, noColor);
    expect(status).toBe(0);
    const lines = readRegister(projectRoot);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).id).toBe(canonicalId);
  });
});

describe.skipIf(!distExists)('yg advise — drill-miss is gated to the current in-repo corpus (spawned)', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-advise-corpus-'));
    cpSync(FIXTURE, projectRoot, { recursive: true });
    // Stage a REAL in-repo corpus for requires-audit: one case a dev line names and
    // one a holdout line names — both genuinely on disk under the aspect's drills/.
    const drills = path.join(projectRoot, '.yggdrasil', 'aspects', 'requires-audit', 'drills');
    for (const c of ['violates-in-dev/case', 'violates-in-holdout/case']) {
      const abs = path.join(drills, `${c}.ts`);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, 'export const x = 1;\n', 'utf-8');
    }
    // A FRESH ruleHash (matching the current rule source) makes an in-corpus dev MISS
    // render as a LIVE "no longer caught" alarm rather than a stale note.
    const graph = await loadGraph(projectRoot);
    const aspect = graph.aspects.find((a) => a.id === 'requires-audit')!;
    const freshHash = ruleHashFor(aspect, 'content.md');

    const mk = (caseLabel: string, src: 'dev' | 'holdout') => ({
      v: 1,
      ts: '2026-07-01T00:00:00.000Z',
      aspect: 'requires-audit',
      case: caseLabel,
      expect: 'refused',
      got: 'satisfied',
      src,
      corpus: src === 'dev' ? 'dev' : 'probe',
      caseHash: 'c'.repeat(64),
      ruleHash: freshHash,
      kind: 'llm',
    });
    writeFileSync(
      path.join(projectRoot, '.yggdrasil', '.drill-results.jsonl'),
      [
        JSON.stringify(mk('violates-in-dev/case', 'dev')), // in-corpus dev → LIVE nomination
        JSON.stringify(mk('violates-orphan/case', 'dev')), // dev, case not in corpus → dropped
        JSON.stringify(mk('violates-in-holdout/case', 'holdout')), // holdout → dropped
      ].join('\n') + '\n',
      'utf-8',
    );
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('surfaces only the in-corpus dev MISS; drops the orphan and the holdout', () => {
    const { status, stdout } = run(['advise', '--all', '--ids'], projectRoot);
    expect(status).toBe(0);
    // The in-corpus dev case surfaces as a LIVE regression alarm, id and all.
    expect(stdout).toContain('id: drill-miss:requires-audit/violates-in-dev/case');
    expect(stdout).toContain("A regression case for rule 'requires-audit' is no longer caught.");
    // The orphan (dev, case gone from the corpus) and the holdout (external
    // measurement) produce NOTHING — nothing left to re-drill or retire.
    expect(stdout).not.toContain('violates-orphan/case');
    expect(stdout).not.toContain('violates-in-holdout/case');
  });
});

describe.skipIf(!distExists)('yg advise — attention count mirrors yg structure (spawned)', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-advise-mirror-'));
    cpSync(FIXTURE, projectRoot, { recursive: true });
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('the attention tunnel count equals the number of tunnels yg structure lists', () => {
    const advise = run(['advise'], projectRoot);
    const structure = run(['structure'], projectRoot);
    expect(advise.status).toBe(0);
    expect(structure.status).toBe(0);

    // advise's attention line reports N (verbatim line text — only N varies).
    const m = advise.stdout.match(
      /(\d+) dependencies jump across distant parts of the architecture — run yg structure to see them/,
    );
    expect(m).not.toBeNull();
    const attentionN = Number(m![1]);

    // yg structure prints exactly one line per tunnel it lists (its top-N farthest).
    const listed = (structure.stdout.match(/ jumps \d+ level/g) ?? []).length;

    // The invariant: advise reports EXACTLY what structure displays — capped at the
    // shared TOP_TUNNELS, never the full cross-tree edge universe. A future drift in
    // either surface breaks this equality.
    expect(attentionN).toBe(listed);
    expect(attentionN).toBeGreaterThanOrEqual(1);
    expect(attentionN).toBeLessThanOrEqual(10);
  });
});

describe.skipIf(!distExists)('yg advise — G4: exit 0 on every loadable fixture (spawned)', () => {
  const FIXTURES_DIR = path.join(CLI_ROOT, 'tests', 'fixtures');
  const loadable = readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(FIXTURES_DIR, e.name, '.yggdrasil')))
    .map((e) => e.name);

  it('finds a corpus of loadable fixtures', () => {
    expect(loadable.length).toBeGreaterThanOrEqual(5);
  });

  it.each(loadable)('bare `yg advise` exits 0 on fixture %s (red states included)', (name) => {
    const { status } = run(['advise'], path.join(FIXTURES_DIR, name));
    expect(status).toBe(0);
  });

  it('a directory with no .yggdrasil graph exits non-zero via the loader error', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'yg-advise-empty-'));
    try {
      const { status } = run(['advise'], empty);
      expect(status).not.toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!distExists)('yg advise — G4: a drill MISS line missing `case` fails open (spawned)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-advise-nocase-'));
    cpSync(FIXTURE, projectRoot, { recursive: true });
    // A corrupted / partially-written local drill line: valid JSON, a real MISS
    // (expect refused, got satisfied), but NO `case` field. drillMissNominations
    // dereferences line.case and passes it to quoteData — quoteData(undefined)
    // throws — so if the reader did not drop this line, the read-only feed would
    // crash. The reader must drop it and the feed must still render and exit 0.
    const line = {
      v: 1,
      ts: '2026-07-01T00:00:00.000Z',
      aspect: 'requires-audit',
      expect: 'refused',
      got: 'satisfied',
      src: 'dev',
      corpus: 'dev',
      caseHash: 'c'.repeat(64),
      ruleHash: '0'.repeat(64),
      kind: 'llm',
    };
    writeFileSync(
      path.join(projectRoot, '.yggdrasil', '.drill-results.jsonl'),
      JSON.stringify(line) + '\n',
      'utf-8',
    );
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('bare `yg advise` exits 0 over a case-less drill MISS line (no crash)', () => {
    const { status } = run(['advise'], projectRoot);
    expect(status).toBe(0);
  });
});

describe('yg advise — G6: no YAML-writing helper is reachable from the advise surface', () => {
  const SRC = path.join(CLI_ROOT, 'src');
  const adviseFiles = [
    path.join(SRC, 'cli', 'advise.ts'),
    path.join(SRC, 'core', 'advise-nominations.ts'),
    path.join(SRC, 'core', 'advise-feed.ts'),
  ];

  it('the advise files import no YAML serializer and no non-JSONL writer', () => {
    for (const f of adviseFiles) {
      const src = readFileSync(f, 'utf-8');
      // No YAML package import at all — the sole YAML-write surface lives there.
      // (JSON.stringify for JSONL is fine; only the `yaml` serializer writes YAML.)
      expect(src).not.toMatch(/from ['"]yaml['"]/);
      expect(src).not.toMatch(/\bstringifyDocument\b/);
      // No filesystem text/YAML write helpers.
      expect(src).not.toMatch(/\bwriteTextFile\b/);
      expect(src).not.toMatch(/\bwriteFileSync\b/);
      expect(src).not.toMatch(/\bappendFileSync\b/);
    }
  });

  it('the committed decisions register (JSONL appender) is the ONLY sanctioned writer used', () => {
    const cli = readFileSync(path.join(SRC, 'cli', 'advise.ts'), 'utf-8');
    expect(cli).toContain('appendDecision');
  });
});

// ── Wave-8 Task 2: advise T2 — family-without-law + architecture-cut ──────────

/** Write a file (creating parent dirs) inside a temp project. */
function w(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/** A minimal, loadable single-node graph (one `svc` unit under src/). */
function makeMinimalGraph(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-advise-t2-${label}-`));
  w(
    dir,
    '.yggdrasil/yg-architecture.yaml',
    `node_types:\n  svc:\n    description: 'a unit'\n    log_required: false\n    when:\n      path: "src/**"\n`,
  );
  w(
    dir,
    '.yggdrasil/yg-config.yaml',
    `reviewer:\n  tiers:\n    standard:\n      provider: claude-code\n      consensus: 1\n      config:\n        model: sonnet\n`,
  );
  w(dir, '.yggdrasil/model/app/yg-node.yaml', `name: App\ndescription: app\ntype: svc\nmapping:\n  - src/app\n`);
  w(dir, 'src/app/a.ts', 'export const a = 1;\n');
  return dir;
}

/** Build one family-candidates payload with `n` planted families (deterministic). */
function familyPayload(ts: string, n: number): unknown {
  const families = [];
  for (let i = 0; i < n; i++) {
    families.push({
      id: `family-typescript-fam${i}`,
      language: 'typescript',
      members: ['A', 'B', 'C', 'D', 'E'].map((s) => `src/data/M${i}${s}Repository.ts`),
      fittedPredicate: { kind: 'glob', value: `src/data/M${i}*Repository.ts` },
      scopeFilesDraft: [`src/data/M${i}*Repository.ts`],
      evidence: { clusterSize: 5, tightness: 0.91, sharedDiscriminatingAspects: [] },
    });
  }
  return { v: 1, ts, coverage: ['typescript'], families };
}

/** Write a family-candidates payload into a project's `.yggdrasil/`. */
function writeCandidates(root: string, payload: unknown): void {
  writeFileSync(
    path.join(root, '.yggdrasil', '.family-candidates.json'),
    JSON.stringify(payload, null, 2) + '\n',
    'utf-8',
  );
}

describe('parseFamilyCandidates — present-or-omit freshness gate (pure)', () => {
  const fresh = () => familyPayload('2026-06-01T00:00:00.000Z', 1) as Record<string, unknown>;

  it('accepts a well-formed, current-format payload and normalizes its families', () => {
    const data = parseFamilyCandidates(fresh());
    expect(data).toBeDefined();
    expect(data!.ts).toBe('2026-06-01T00:00:00.000Z');
    expect(data!.families).toHaveLength(1);
    expect(data!.families[0].id).toBe('family-typescript-fam0');
    expect(data!.families[0].fittedPredicate.value).toBe('src/data/M0*Repository.ts');
    expect(data!.families[0].members).toHaveLength(5);
  });

  it('omits (undefined) when the file format / schema-lineage version is not the supported one', () => {
    // `v` is the schema-lineage token: a bump (which a moved shard schema forces via
    // the build-time coupling below) makes an old file read as stale → omitted, so a
    // stale-schema file is never rendered as live.
    expect(parseFamilyCandidates({ ...fresh(), v: 2 })).toBeUndefined();
  });

  it('omits (undefined) when ts is missing or not a real instant', () => {
    expect(parseFamilyCandidates({ ...fresh(), ts: 'not-a-date' })).toBeUndefined();
    const noTs = fresh();
    delete noTs.ts;
    expect(parseFamilyCandidates(noTs)).toBeUndefined();
  });

  it('accepts a fresh file with an empty family list (class runs, produces nothing)', () => {
    const empty = parseFamilyCandidates(familyPayload('2026-06-01T00:00:00.000Z', 0));
    expect(empty).toBeDefined();
    expect(empty!.families).toHaveLength(0);
  });

  it('drops a malformed family entry but keeps the well-formed ones', () => {
    const payload = fresh();
    (payload.families as unknown[]).push({ id: 'family-x', language: 'typescript' }); // no members/predicate
    const data = parseFamilyCandidates(payload);
    expect(data!.families).toHaveLength(1); // the malformed one dropped
  });

  it('omits a garbled (non-object) value', () => {
    expect(parseFamilyCandidates(null)).toBeUndefined();
    expect(parseFamilyCandidates('nope')).toBeUndefined();
  });

  it('drops a null (non-object) family entry but keeps the well-formed ones', () => {
    const payload = fresh();
    (payload.families as unknown[]).push(null);
    const data = parseFamilyCandidates(payload);
    expect(data).toBeDefined();
    expect(data!.families).toHaveLength(1); // the null entry dropped
  });

  it('falls back to member count / zero tightness when the evidence object is missing', () => {
    const payload = fresh();
    const family = (payload.families as Record<string, unknown>[])[0];
    delete family.evidence; // no evidence object at all
    const data = parseFamilyCandidates(payload);
    expect(data).toBeDefined();
    expect(data!.families).toHaveLength(1);
    expect(data!.families[0].clusterSize).toBe(data!.families[0].members.length); // fallback: member count
    expect(data!.families[0].tightness).toBe(0); // fallback: zero
  });

  it('treats a missing `families` field as an empty (but still fresh) list', () => {
    const payload = fresh();
    delete (payload as Record<string, unknown>).families;
    const data = parseFamilyCandidates(payload);
    expect(data).toBeDefined();
    expect(data!.families).toHaveLength(0);
  });

  it('is anchored to the live shard schema by a build-time coupling (RZ-21 re-gate)', () => {
    // The candidates format is validated against one AST-shard schema. If the engine's
    // live schema ever advances past it, THIS assertion fails — reddening the build so a
    // human must re-validate the miner before any family mined under a moved schema could
    // be shown. This is how the family class "gates on CACHE_SCHEMA_VERSION" without the
    // read-only command layer importing the relation-analysis subsystem at runtime.
    //
    // LOCKSTEP on re-green: when CACHE_SCHEMA_VERSION has moved, do NOT re-green by bumping
    // CANDIDATES_SHARD_SCHEMA alone. Bump BOTH CANDIDATES_SHARD_SCHEMA (the anchor) AND
    // SUPPORTED_CANDIDATES_V (the accepted candidates-file `v`) together, and have the miner
    // emit the new `v`. The anchor-only bump leaves parseFamilyCandidates still accepting the
    // old `v`, so a candidates file mined under the OLD schema keeps parsing and would render
    // as a live family proposal; the `v` bump is the reject-on-old gate that rejects it at
    // parse. The failure message below states this so the reconciliation is the COMPLETE one.
    expect(
      CACHE_SCHEMA_VERSION,
      'AST-shard schema (CACHE_SCHEMA_VERSION) moved past the family-miner anchor. ' +
        'Re-validate the miner, then bump BOTH CANDIDATES_SHARD_SCHEMA (the anchor) AND ' +
        'SUPPORTED_CANDIDATES_V (the accepted candidates-file `v`) in lockstep, and have the ' +
        'miner emit the new `v`. Bumping CANDIDATES_SHARD_SCHEMA alone re-greens this test ' +
        'while parseFamilyCandidates still accepts the old `v`, so a candidates file mined ' +
        'under the OLD schema keeps parsing and would render as a live family proposal. A ' +
        'stale-schema file must be rejected at parse via the `v` gate — never shown as a ' +
        'live family proposal.',
    ).toBe(CANDIDATES_SHARD_SCHEMA);
  });
});

describe.skipIf(!distExists)('parseFamilyCandidates — reject-on-old-v guard (end-to-end)', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = makeMinimalGraph('stale-v');
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('a candidates file whose v is below SUPPORTED_CANDIDATES_V yields no family nomination', async () => {
    // The reject-on-old-v guard, end-to-end. A file mined under a superseded shard schema
    // carries a `v` below the accepted one; parseFamilyCandidates omits it, so buildNominations
    // emits no family-without-law item. This is the guard that keeps a stale-schema file from
    // ever rendering as a live family proposal — the reason SUPPORTED_CANDIDATES_V must move in
    // lockstep with any shard-schema bump (see the build-time coupling test above).
    const staleV = {
      ...(familyPayload('2026-06-01T00:00:00.000Z', 1) as Record<string, unknown>),
      v: SUPPORTED_CANDIDATES_V - 1,
    };
    expect(parseFamilyCandidates(staleV)).toBeUndefined();

    const graph = await loadGraph(projectRoot);
    const noms = buildNominations(graph, {
      todayUtc: new Date('2026-07-12T00:00:00.000Z'),
      familyCandidates: parseFamilyCandidates(staleV),
    });
    expect(noms.some((n) => n.id.startsWith('family-without-law:'))).toBe(false);
  });
});

describe.skipIf(!distExists)('buildNominations — T2 ranks strictly below every T1 (pure)', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = makeMinimalGraph('rank');
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('places family and architecture-cut below all T0/T1, family above architecture-cut', async () => {
    const graph = await loadGraph(projectRoot);
    const familyCandidates = parseFamilyCandidates(familyPayload('2026-06-01T00:00:00.000Z', 1));
    const noms = buildNominations(graph, {
      todayUtc: new Date('2026-07-12T00:00:00.000Z'),
      familyCandidates,
      architectureCutCycles: [{ depth: 1, blocks: ['ga', 'gb'] }],
    });

    const family = noms.find((n) => n.id.startsWith('family-without-law:'));
    const cut = noms.find((n) => n.id.startsWith('architecture-cut:'));
    expect(family).toBeDefined();
    expect(cut).toBeDefined();

    // The lowest-priority T1 class (uncovered-hot-spot) ranks 90; T2 is strictly
    // below every T1, so both T2 ranks exceed 90, and family outranks the cut.
    expect(family!.classRank).toBeGreaterThan(90);
    expect(cut!.classRank).toBeGreaterThan(family!.classRank);

    // Every OTHER nomination present ranks strictly above both T2 classes.
    for (const n of noms) {
      if (n === family || n === cut) continue;
      expect(n.classRank).toBeLessThan(family!.classRank);
    }

    // The engine returns the list already classRank-sorted, so family precedes cut.
    expect(noms.indexOf(family!)).toBeLessThan(noms.indexOf(cut!));
  });
});

describe.skipIf(!distExists)('yg advise — T2 family-without-law (spawned)', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = makeMinimalGraph('family');
    writeCandidates(projectRoot, familyPayload('2026-06-01T00:00:00.000Z', 1));
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('renders exactly one family item as quoted data with provenance and the consent NEXT, exit 0', () => {
    const { status, stdout } = run(['advise'], projectRoot);
    expect(status).toBe(0);

    // WHAT names the N member files as quoted data.
    expect(stdout).toContain('A candidate rule family — 5 files share no rule of their own');
    expect(stdout).toContain("'src/data/M0ARepository.ts'");
    expect(stdout).toContain("'src/data/M0ERepository.ts'");

    // WHY carries the fitted predicate + tightness + scope skeleton, with provenance.
    expect(stdout).toContain('local analysis since 2026-06-01T00:00:00.000Z');
    expect(stdout).toContain('tightness 0.91');
    expect(stdout).toContain('src/data/M0*Repository.ts');
    expect(stdout).toContain('.family-candidates.json:2026-06-01T00:00:00.000Z');

    // NEXT names the exact action and ends with the literal consent suffix.
    expect(stdout).toContain('Create a draft aspect scoped to');
    expect(stdout).toMatch(/for these 5 files, then supply the rationale — never invent it — requires your consent\./);

    // Exactly one family item (one planted family).
    expect((stdout.match(/A candidate rule family —/g) ?? []).length).toBe(1);
  });

  it('--ids shows the family stable id under the item', () => {
    const { status, stdout } = run(['advise', '--ids'], projectRoot);
    expect(status).toBe(0);
    expect(stdout).toContain('id: family-without-law:family-typescript-fam0');
  });

  it('omits the class silently when the candidates file is absent', () => {
    rmSync(path.join(projectRoot, '.yggdrasil', '.family-candidates.json'));
    const { status, stdout } = run(['advise'], projectRoot);
    expect(status).toBe(0);
    expect(stdout).not.toContain('candidate rule family');
  });
});

describe.skipIf(!distExists)('yg advise — T2 architecture-cut (spawned)', () => {
  /**
   * Two module groups `ga` and `gb`, each a `svc` child, that `uses` each other.
   * The depth-1 quotient collapses the services to their groups, forming a loop.
   * With `cyclic=false` only ga → gb is declared, so the quotient is acyclic.
   */
  function makeGroups(label: string, cyclic: boolean): string {
    const dir = mkdtempSync(path.join(tmpdir(), `yg-advise-cut-${label}-`));
    w(
      dir,
      '.yggdrasil/yg-architecture.yaml',
      `node_types:\n` +
        `  grp:\n    description: 'organizational group'\n    log_required: false\n` +
        `  svc:\n    description: 'a service'\n    log_required: false\n    when:\n      path: "src/**"\n    parents: [grp]\n    relations:\n      uses: [svc]\n`,
    );
    w(
      dir,
      '.yggdrasil/yg-config.yaml',
      `reviewer:\n  tiers:\n    standard:\n      provider: claude-code\n      consensus: 1\n      config:\n        model: sonnet\n`,
    );
    w(dir, '.yggdrasil/model/ga/yg-node.yaml', `name: GroupA\ndescription: group a\ntype: grp\n`);
    w(dir, '.yggdrasil/model/gb/yg-node.yaml', `name: GroupB\ndescription: group b\ntype: grp\n`);
    w(
      dir,
      '.yggdrasil/model/ga/svc/yg-node.yaml',
      `name: SvcA\ndescription: service a\ntype: svc\nmapping:\n  - src/ga\nrelations:\n  - target: gb/svc\n    type: uses\n`,
    );
    const gbRel = cyclic ? `relations:\n  - target: ga/svc\n    type: uses\n` : '';
    w(
      dir,
      '.yggdrasil/model/gb/svc/yg-node.yaml',
      `name: SvcB\ndescription: service b\ntype: svc\nmapping:\n  - src/gb\n${gbRel}`,
    );
    w(dir, 'src/ga/x.ts', 'export const x = 1;\n');
    w(dir, 'src/gb/y.ts', 'export const y = 1;\n');
    return dir;
  }

  it('names both module groups plainly for a 2-block loop, in plain language, exit 0', () => {
    const dir = makeGroups('cyclic', true);
    try {
      const { status, stdout } = run(['advise'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain("Module groups 'ga', 'gb' depend on each other in a loop.");
      expect(stdout).toContain('structure quotient depth 1');
      expect(stdout).toContain('Consider a cut between these module groups, or declare a contract (a port) across the boundary — requires your consent.');
      // Exactly one item (the finer depth-2 view of the same loop is suppressed).
      expect((stdout.match(/depend on each other in a loop/g) ?? []).length).toBe(1);
      // NEVER the internal graph-theory terms in user-facing output.
      expect(stdout).not.toContain('SCC');
      expect(stdout).not.toContain('strongly connected');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits the class when the quotient is acyclic (one-way dependency), exit 0', () => {
    const dir = makeGroups('acyclic', false);
    try {
      const { status, stdout } = run(['advise'], dir);
      expect(status).toBe(0);
      expect(stdout).not.toContain('depend on each other in a loop');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!distExists)('yg advise — T2 shares the JOINT cap with T1 (non-additive, spawned)', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = makeMinimalGraph('cap');
    // A far-past review_by makes one T0 overdue item live alongside the T2 families.
    w(
      projectRoot,
      '.yggdrasil/aspects/needs-review/yg-aspect.yaml',
      `name: NeedsReview\ndescription: a rule\nreviewer:\n  type: llm\nreview_by: 2020-01-01\n`,
    );
    w(projectRoot, '.yggdrasil/aspects/needs-review/content.md', '# NeedsReview\n\nThe unit must be reviewed.\n');
    appendFileSync(
      path.join(projectRoot, '.yggdrasil', 'model', 'app', 'yg-node.yaml'),
      'aspects:\n  - needs-review\n',
      'utf-8',
    );
    // 12 planted families → 12 T2 items, plus the 1 T0 overdue = 13 total nominations.
    writeCandidates(projectRoot, familyPayload('2026-06-01T00:00:00.000Z', 12));
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('caps the COMBINED feed at 10 (T0 + T2 together, not 10 per tier)', () => {
    const { status, stdout } = run(['advise'], projectRoot);
    expect(status).toBe(0);

    const overdueShown = stdout.includes('is past its review_by date');
    const familiesShown = (stdout.match(/A candidate rule family —/g) ?? []).length;
    expect(overdueShown).toBe(true); // the T0 outranks every family
    // 13 total, cap 10 → 1 T0 + 9 families shown (NOT 1 + 10 = 11: the cap is joint).
    expect(familiesShown).toBe(9);
    expect(stdout).toMatch(/and 3 more nomination/);
  });

  it('--all lifts the cap and shows every family', () => {
    const { status, stdout } = run(['advise', '--all'], projectRoot);
    expect(status).toBe(0);
    expect((stdout.match(/A candidate rule family —/g) ?? []).length).toBe(12);
  });
});

describe('gatherChurnByNode — git history is an EXTERNAL input now, never fetched inside this function', () => {
  it('gatherChurnByNode contains NO git subprocess call at all — the misattribution risk a prior split guarded against by ORDERING is now eliminated STRUCTURALLY, by removing the git try/catch from this function entirely (Task 12: the git fetch is shared with the type-covered-churn counter, so it moved to its own gatherChurnHistory)', () => {
    // Before Task 12, this function ran its own git subprocess AFTER resolving the
    // owner index, so a filesystem-walk fault could never be misattributed to "no
    // readable git history" only because of THAT ordering. Task 12 needed the SAME
    // git history shared with a second counter (countChurnByTypeCoveredFile), so the
    // fetch moved out into gatherChurnHistory — this function now takes
    // touchesByCommit as a plain parameter and contains no git call whatsoever, which
    // removes the misattribution risk outright rather than merely ordering around it.
    const src = readFileSync(path.join(CLI_ROOT, 'src', 'cli', 'advise.ts'), 'utf-8');
    const fnSrc = src.slice(
      src.indexOf('async function gatherChurnByNode'),
      src.indexOf('\n}\n', src.indexOf('async function gatherChurnByNode')),
    );
    expect(fnSrc).toContain('ownerOfForGraph(graph)');
    expect(fnSrc).not.toContain('execFileSync');
  });

  it('the git history fetch (shallow probe + git log) lives in exactly ONE function, called once per yg advise run and threaded to both churn counters — never doubled for the type-covered-churn source', () => {
    const src = readFileSync(path.join(CLI_ROOT, 'src', 'cli', 'advise.ts'), 'utf-8');
    // Exactly two execFileSync('git', ...) call sites in the whole module: the
    // shallow-repository probe and the `git log` call, both inside the ONE shared
    // gatherChurnHistory. A caller (gatherChurnByNode, gatherTypeCoveredChurn) that
    // wanted its own history would add a third or fourth call site here.
    const gitCallSites = [...src.matchAll(/execFileSync\('git'/g)].length;
    expect(gitCallSites).toBe(2);
    const fetchFnSrc = src.slice(
      src.indexOf('function gatherChurnHistory'),
      src.indexOf('\n}\n', src.indexOf('function gatherChurnHistory')),
    );
    expect((fetchFnSrc.match(/execFileSync\('git'/g) ?? []).length).toBe(2);
  });
});
