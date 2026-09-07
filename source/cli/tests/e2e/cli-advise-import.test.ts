// =============================================================================
// CLI E2E — `yg advise import` and `yg advise --json`.
//
// Another tool can measure things about this repository that the graph cannot
// see for itself — which components change together, which one looks like two.
// Until now those findings had nowhere to land except a human's memory. They
// land in the attention feed now, as PROPOSALS: visibly measured by someone
// else, at a named commit, with that producer's own evidence kept verbatim.
//
// Importing is not accepting. Every scenario below checks that the boundary
// holds: the item arrives as something to weigh, the decision stays the user's,
// and nothing the producer said is ever restated as this graph's own finding.
//
//   1. import      → items land, and the run says they are proposals
//   2. feed        → each names its producer, its commit and its evidence
//   3. --json      → the same items, uncapped, each with structured provenance
//   4. idempotent  → re-importing the same document adds nothing
//   5. decisions   → an imported item dismisses and defers like any other
//   6. refusals    → wrong schema, unknown kind, unreadable source, bad JSON
//   7. real doc    → a document the real producer wrote, imported as-is
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
// A document the REAL producer wrote, measured over this very repository.
const REAL_ADVICE = path.join(CLI_ROOT, 'tests', 'fixtures', 'grain-advice', 'advice.json');
const distExists = existsSync(BIN_PATH);

const REGISTER = path.join('.yggdrasil', 'advise-imported.jsonl');

/** A small, hand-written document in the documented shape — two kinds, one of each. */
const DOC = {
  schema: 'grain-advice/1',
  repo: '.',
  at: 'b36f24e36e6f1b761078de4276c978717cd65a86',
  items: [
    {
      kind: 'relation',
      nodes: ['services/orders', 'services/payments'],
      confidence: 0.41,
      evidence: { coChanged: 31, ofA: 0.31, ofB: 0.4, declared: false },
      text: 'Orders and Payments change together 31 times but the graph declares nothing between them.',
    },
    {
      kind: 'split',
      nodes: ['services/orders'],
      candidates: ['services/orders/api', 'services/orders/store'],
      evidence: { clusters: 2, cut: 0.08 },
      text: 'Orders looks like two things: an API surface and a store.',
    },
  ],
};

function run(args: string[], cwd: string, input?: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8', input, maxBuffer: 32 * 1024 * 1024 });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-adviseimport-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Write the sample document into the project and return its path. */
function writeDoc(dir: string, doc: unknown = DOC): string {
  const file = path.join(dir, 'advice.json');
  writeFileSync(file, `${JSON.stringify(doc, null, 1)}\n`);
  return file;
}

interface AdviseDoc {
  schema: string;
  attention: string[];
  items: Array<{ id: string; what: string; why: string; next: string; evidenceHash: string; provenance?: { source: string; at: string | null } }>;
  suppressed: Array<{ id: string; provenance?: { source: string; at: string | null } }>;
}

describe.skipIf(!distExists)('CLI E2E — yg advise import', () => {
  it('1+2: proposals land in the feed naming their producer, its commit and its own evidence', () => {
    const dir = copyFixture('land');
    try {
      const imported = run(['advise', 'import', writeDoc(dir)], dir);
      expect(imported.status).toBe(0);
      expect(imported.stdout).toContain("Recorded 2 proposals from 'grain'.");
      // The boundary, stated where the user reads it.
      expect(imported.stdout).toContain('They are proposals, not decisions');

      const feed = run(['advise', '--all'], dir);
      expect(feed.status).toBe(0);
      expect(feed.stdout).toContain('grain proposes (relation):');
      expect(feed.stdout).toContain('Orders and Payments change together 31 times');
      // Provenance: who measured it, and at which commit.
      expect(feed.stdout).toContain('measured by grain at commit b36f24e36e6f');
      // The producer's own evidence, kept and shown rather than re-derived.
      expect(feed.stdout).toContain('coChanged=31');
      // Never restated as this graph's own finding.
      expect(feed.stdout).toContain('a proposal from outside this graph, not a finding of its own');
      // And acting on it is still the user's act.
      expect(feed.stdout).toContain('This requires your approval.');
      // The split item's next is written in the graph's own terms.
      expect(feed.stdout).toContain('grain proposes (split):');
      expect(feed.stdout).toContain('the proposal names services/orders/api and services/orders/store');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3: --json carries the same items with structured provenance', () => {
    const dir = copyFixture('json');
    try {
      run(['advise', 'import', writeDoc(dir)], dir);
      const result = run(['advise', '--json'], dir);
      expect(result.status).toBe(0);
      const doc = JSON.parse(result.stdout) as AdviseDoc;
      expect(doc.schema).toBe('yg-advise/1');

      const proposals = doc.items.filter((i) => i.provenance !== undefined);
      expect(proposals).toHaveLength(2);
      for (const item of proposals) {
        expect(item.provenance).toEqual({ source: 'grain', at: 'b36f24e36e6f1b761078de4276c978717cd65a86' });
        expect(item.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
        expect(item.id.startsWith('imported:grain:')).toBe(true);
      }
      // An item the graph found itself carries no provenance — which is what
      // makes the field meaningful on the ones that do.
      for (const item of doc.items.filter((i) => !i.id.startsWith('imported:'))) {
        expect(item.provenance).toBeUndefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3b: the reader-only selectors are refused with --json, not silently ignored', () => {
    const dir = copyFixture('json-selectors');
    try {
      for (const flag of ['--all', '--ids']) {
        const refused = run(['advise', '--json', flag], dir);
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain(`${flag} cannot be combined with --json`);
        expect(refused.stdout).toBe('');
      }
      const both = run(['advise', '--json', '--all', '--ids'], dir);
      expect(both.status).toBe(1);
      expect(both.stderr).toContain('--all and --ids cannot be combined with --json');
      // Each on its own still works — the refusal is about the combination.
      expect(run(['advise', '--json'], dir).status).toBe(0);
      expect(run(['advise', '--all', '--ids'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: importing the same document again adds nothing, from a file or from standard input', () => {
    const dir = copyFixture('idempotent');
    try {
      const file = writeDoc(dir);
      run(['advise', 'import', file], dir);
      const again = run(['advise', 'import', file], dir);
      expect(again.stdout).toContain('Recorded 0 proposals');
      expect(again.stdout).toContain('2 were already recorded');

      const piped = run(['advise', 'import', '-'], dir, readFileSync(file, 'utf-8'));
      expect(piped.status).toBe(0);
      expect(piped.stdout).toContain('Recorded 0 proposals');

      // One line per proposal, never a duplicate.
      const lines = readFileSync(path.join(dir, REGISTER), 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      const keys = lines.map((l) => (JSON.parse(l) as { key: string }).key);
      expect(new Set(keys).size).toBe(2);

      // A document measured at a NEW commit is a new proposal: the evidence
      // behind it was taken again, over code that has moved.
      const later = writeDoc(dir, { ...DOC, at: '0000000000000000000000000000000000000000' });
      const fresh = run(['advise', 'import', later], dir);
      expect(fresh.stdout).toContain('Recorded 2 proposals');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5: an imported proposal dismisses like any other item, and the decision is the user\'s', () => {
    const dir = copyFixture('decide');
    try {
      run(['advise', 'import', writeDoc(dir)], dir);
      const doc = JSON.parse(run(['advise', '--json'], dir).stdout) as AdviseDoc;
      const item = doc.items.find((i) => i.id.startsWith('imported:'))!;

      const dismissed = run(['advise', 'dismiss', item.id, '--reason', 'The two really are independent; the co-change is release churn.'], dir);
      expect(dismissed.status).toBe(0);

      const after = JSON.parse(run(['advise', '--json'], dir).stdout) as AdviseDoc;
      expect(after.items.map((i) => i.id)).not.toContain(item.id);
      expect(after.suppressed.map((i) => i.id)).toContain(item.id);
      // Importing did not decide anything: the decision is a separate, recorded act.
      expect(readFileSync(path.join(dir, '.yggdrasil', 'advise-decisions.jsonl'), 'utf-8')).toContain('release churn');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6: every refusal says what, why and next, and records nothing', () => {
    const dir = copyFixture('refuse');
    try {
      const wrongSchema = path.join(dir, 'wrong.json');
      writeFileSync(wrongSchema, JSON.stringify({ schema: 'other/1', items: [] }));
      const a = run(['advise', 'import', wrongSchema], dir);
      expect(a.status).toBe(1);
      expect(a.stderr).toContain("names 'other/1' as its schema, not 'grain-advice/1'");
      expect(a.stderr).toContain('read by the contract it names');

      const unknownKind = path.join(dir, 'kind.json');
      writeFileSync(unknownKind, JSON.stringify({ schema: 'grain-advice/1', items: [{ kind: 'vibes', nodes: ['a'], text: 'x' }] }));
      const b = run(['advise', 'import', unknownKind], dir);
      expect(b.status).toBe(1);
      expect(b.stderr).toContain("kind 'vibes', which this graph has no vocabulary for");
      expect(b.stderr).toContain('relation, split, port, rule');

      const notJson = path.join(dir, 'broken.json');
      writeFileSync(notJson, '{ not json');
      const c = run(['advise', 'import', notJson], dir);
      expect(c.status).toBe(1);
      expect(c.stderr).toContain('not valid JSON');

      const d = run(['advise', 'import', path.join(dir, 'absent.json')], dir);
      expect(d.status).toBe(1);
      expect(d.stderr).toContain('could not be read');
      expect(d.stderr).toContain('yg advise import -');

      // Nothing was recorded by any of them.
      expect(existsSync(path.join(dir, REGISTER))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('7: a document the real producer wrote imports as-is, evidence kept verbatim', () => {
    const dir = copyFixture('real');
    try {
      const real = JSON.parse(readFileSync(REAL_ADVICE, 'utf-8')) as {
        schema: string;
        at: string;
        items: Array<{ kind: string; nodes: string[]; evidence: Record<string, unknown>; text: string }>;
      };
      expect(real.schema).toBe('grain-advice/1');
      expect(real.items.length).toBeGreaterThan(0);

      const result = run(['advise', 'import', REAL_ADVICE], dir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Recorded ${real.items.length} proposal`);

      // The producer's evidence object survives the round trip untouched — this
      // graph stores what was measured, it never re-derives it.
      const lines = readFileSync(path.join(dir, REGISTER), 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(real.items.length);
      for (let i = 0; i < lines.length; i++) {
        const record = JSON.parse(lines[i]) as { source: string; schema: string; at: string; kind: string; nodes: string[]; evidence: Record<string, unknown>; text: string };
        expect(record.source).toBe('grain');
        expect(record.schema).toBe('grain-advice/1');
        expect(record.at).toBe(real.at);
        expect(record.kind).toBe(real.items[i].kind);
        expect(record.nodes).toEqual(real.items[i].nodes);
        expect(record.evidence).toEqual(real.items[i].evidence);
        expect(record.text).toBe(real.items[i].text);
      }

      const doc = JSON.parse(run(['advise', '--json'], dir).stdout) as AdviseDoc;
      expect(doc.items.filter((i) => i.provenance?.source === 'grain')).toHaveLength(real.items.length);

      // A nested evidence value reads as what was actually measured. The real
      // producer's split items carry objects, and showing the language's
      // placeholder for one would tell the reader nothing at all.
      const feed = run(['advise', '--all'], dir).all;
      expect(feed).not.toContain('[object Object]');
      expect(feed).toContain('cochangeCrossing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
