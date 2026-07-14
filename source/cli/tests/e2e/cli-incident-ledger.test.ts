// =============================================================================
// CLI E2E — the incident ledger (wave-7): `yg incident add`, the committed
// `.yggdrasil/incidents.md`, the ascending-datetime validator warning, and the
// `yg advise` reality-counter line.
//
// Pins the public CLI surface (spawn the built bin.js). The ledger is the tower's
// only EXTERNAL oracle: a human records what escaped enforcement and how, tagged by
// cause. `yg incident add` appends one `## [<ISO>] <tag>` entry (append-only,
// datetimes strictly ascending). `yg check` WARNS (never blocks) on out-of-order
// datetimes; a missing file is tolerated (no warning). `yg advise` surfaces the
// count as a reality-counter Attention line, shown for 0 or N.
//
//   1. add creates the file with one entry; a second add appends a LATER datetime.
//   2. two DESCENDING datetimes → exactly ONE non-blocking warning (yg check exit 0).
//   3. no incidents.md → no warning (yg check clean of the code).
//   4. --tag banana → rejected (non-zero) with the valid-tag list; nothing written.
//   5. yg advise shows the reality-counter line at 0 and at N (+ wrong-rule evidence).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

const INCIDENTS_REL = path.join('.yggdrasil', 'incidents.md');

/** The reality-counter line, verbatim (only N varies). */
const COUNTER_RE =
  /(\d+) incidents on record — the only external oracle; see \.yggdrasil\/incidents\.md/g;

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

function w(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/** A minimal, otherwise-clean loadable graph (one node owning src/svc, no rules). */
function makeFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-incident-${label}-`));
  w(
    dir,
    '.yggdrasil/yg-architecture.yaml',
    `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "src/**"\n`,
  );
  w(
    dir,
    '.yggdrasil/yg-config.yaml',
    `reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n`,
  );
  w(dir, '.yggdrasil/model/svc/yg-node.yaml', `name: Svc\ndescription: service unit\ntype: service\nmapping:\n  - src/svc\n`);
  w(dir, 'src/svc/a.ts', 'export const a = 1;\n');
  return dir;
}

/** Extract the datetimes from every `## [<ISO>] <tag>` header, in file order. */
function headerDatetimes(text: string): string[] {
  const re = /^##\s+\[([^\]]+)\]\s+\S+\s*$/gm;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

describe.skipIf(!distExists)('CLI E2E — incident ledger', () => {
  it('1. add creates incidents.md with one entry; a second add appends a later datetime (exit 0)', () => {
    const dir = makeFixture('add');
    try {
      expect(existsSync(path.join(dir, INCIDENTS_REL))).toBe(false);

      const first = run(
        ['incident', 'add', '--tag', 'wrong-rule', '--reason', 'a UI file reached the DB and no rule caught it'],
        dir,
      );
      expect(first.status).toBe(0);
      expect(existsSync(path.join(dir, INCIDENTS_REL))).toBe(true);

      let body = readFileSync(path.join(dir, INCIDENTS_REL), 'utf-8');
      let dates = headerDatetimes(body);
      expect(dates).toHaveLength(1);
      expect(body).toContain('wrong-rule');
      expect(body).toContain('a UI file reached the DB and no rule caught it');

      const second = run(
        ['incident', 'add', '--tag', 'no-rule', '--reason', 'a whole concern shipped with no rule at all'],
        dir,
      );
      expect(second.status).toBe(0);

      body = readFileSync(path.join(dir, INCIDENTS_REL), 'utf-8');
      dates = headerDatetimes(body);
      expect(dates).toHaveLength(2);
      // Append-only + strictly ascending: the second datetime is strictly later.
      expect(Date.parse(dates[1])).toBeGreaterThan(Date.parse(dates[0]));
      expect(body).toContain('no-rule');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2. two DESCENDING datetimes → exactly ONE non-blocking warning; yg check stays exit 0', () => {
    const dir = makeFixture('desc');
    try {
      // Hand-written ledger with datetimes in DESCENDING order (a reordering merge
      // or a hand-edit) — the only external oracle must never block CI, so this is a
      // WARNING, never an error.
      w(
        dir,
        INCIDENTS_REL,
        `# Incident ledger\n\n## [2026-07-10T00:00:00.000Z] no-rule\n\nlater entry, written first\n\n## [2026-07-05T00:00:00.000Z] wrong-rule\n\nearlier entry, written second — out of order\n\n`,
      );

      const { status, stdout, stderr } = run(['check'], dir);
      const out = stdout + stderr;
      // Non-gating: the ledger warning never fails the build.
      expect(status).toBe(0);
      const matches = [...out.matchAll(/incident-ledger-out-of-order/g)];
      expect(matches).toHaveLength(1);
      expect(out).toContain('not strictly ascending');
      // It is a WARNING, not an error.
      expect(out).not.toMatch(/error[^]*incident-ledger-out-of-order/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3. no incidents.md → no out-of-order warning (absence tolerated), exit 0', () => {
    const dir = makeFixture('absent');
    try {
      expect(existsSync(path.join(dir, INCIDENTS_REL))).toBe(false);
      const { status, stdout, stderr } = run(['check'], dir);
      expect(status).toBe(0);
      expect(stdout + stderr).not.toContain('incident-ledger-out-of-order');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4. --tag banana is rejected with the valid-tag list and writes nothing', () => {
    const dir = makeFixture('badtag');
    try {
      const { status, stderr } = run(
        ['incident', 'add', '--tag', 'banana', '--reason', 'whatever'],
        dir,
      );
      expect(status).not.toBe(0);
      // The full valid-tag vocabulary is named so the human can correct it.
      for (const tag of ['no-rule', 'wrong-rule', 'judges-blind', 'single-judge-miss', 'not-enforcement']) {
        expect(stderr).toContain(tag);
      }
      // Rejected input never touches the committed ledger.
      expect(existsSync(path.join(dir, INCIDENTS_REL))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5. yg advise shows the reality-counter at 0, then at N with wrong-rule evidence (exit 0)', () => {
    const dir = makeFixture('advise');
    try {
      const empty = run(['advise'], dir);
      expect(empty.status).toBe(0);
      let m = [...empty.stdout.matchAll(COUNTER_RE)];
      expect(m).toHaveLength(1);
      expect(Number(m[0][1])).toBe(0); // an empty ledger reads honestly as 0
      expect(empty.stdout).not.toContain('wrong-rule incidents recorded'); // no evidence line at 0

      run(['incident', 'add', '--tag', 'wrong-rule', '--reason', 'a rule fired on the wrong thing'], dir);

      const withOne = run(['advise'], dir);
      expect(withOne.status).toBe(0);
      m = [...withOne.stdout.matchAll(COUNTER_RE)];
      expect(m).toHaveLength(1);
      expect(Number(m[0][1])).toBe(1);
      // A wrong-rule incident joins the health story as evidence.
      expect(withOne.stdout).toContain('wrong-rule incidents recorded — rules may be miscalibrated; see incidents.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
