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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');
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
  it('registers `yg advise` with dismiss and defer subcommands', () => {
    const program = new Command();
    registerAdviseCommand(program);
    const advise = program.commands.find((c) => c.name() === 'advise');
    expect(advise).toBeDefined();
    const subs = (advise!.commands ?? []).map((c) => c.name()).sort();
    expect(subs).toEqual(['defer', 'dismiss']);
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
