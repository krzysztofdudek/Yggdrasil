// Unit tests for the incident ledger: the committed-testimony store
// (io/incidents-store) and the `yg incident` command registration shape.
//
// The store is exercised with an INJECTED datetime (appendIncident takes the ISO
// string as a parameter), so every assertion is fully deterministic — no wall
// clock, no Math.random — and each test uses a fresh temp dir.

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  INCIDENT_TAGS,
  isValidIncidentTag,
  parseIncidents,
  formatIncidentEntry,
  appendIncident,
  readIncidents,
  countIncidents,
  countWrongRuleIncidentsByAspect,
} from '../../../src/io/incidents-store.js';
import { checkIncidentLedger } from '../../../src/core/checks/incident-ledger.js';
import { registerIncidentCommand } from '../../../src/cli/incident.js';
import type { Graph } from '../../../src/model/graph.js';

/** A minimal graph carrier (the check reads only `rootPath`) over a real on-disk
 *  ledger — the same shape the other check unit tests use. */
function mkGraph(rootPath: string): Graph {
  return { rootPath } as unknown as Graph;
}

/** A fresh, real `.yggdrasil/` root holding the given incidents.md text (or none). */
function rootWithLedger(text?: string): string {
  const root = path.join(mkdtempSync(path.join(tmpdir(), 'yg-incident-check-')), '.yggdrasil');
  mkdirSync(root, { recursive: true });
  if (text !== undefined) writeFileSync(path.join(root, 'incidents.md'), text, 'utf-8');
  return root;
}

/** A fresh, real `.yggdrasil/` root per test (no shared state). The graph root
 *  always exists on disk in production, so the store never creates it. */
function freshRoot(): string {
  const root = path.join(mkdtempSync(path.join(tmpdir(), 'yg-incident-unit-')), '.yggdrasil');
  mkdirSync(root, { recursive: true });
  return root;
}

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';
const T3 = '2026-03-01T00:00:00.000Z';

describe('incidents-store — tag vocabulary', () => {
  it('accepts exactly the five sanctioned causes and rejects anything else', () => {
    expect([...INCIDENT_TAGS]).toEqual([
      'no-rule',
      'wrong-rule',
      'judges-blind',
      'single-judge-miss',
      'not-enforcement',
    ]);
    for (const tag of INCIDENT_TAGS) expect(isValidIncidentTag(tag)).toBe(true);
    expect(isValidIncidentTag('banana')).toBe(false);
    expect(isValidIncidentTag('')).toBe(false);
    expect(isValidIncidentTag('WRONG-RULE')).toBe(false);
  });
});

describe('incidents-store — parsing', () => {
  it('reads only machine-shaped headers and ignores preamble / prose', () => {
    const text =
      `# Incident ledger\n\nsome preamble prose\n\n` +
      `## [${T1}] no-rule\n\na concern shipped uncovered\n\n` +
      `## [${T2}] wrong-rule\n\nrule fired on the wrong thing\n\n`;
    const entries = parseIncidents(text);
    expect(entries).toEqual([
      { datetime: T1, tag: 'no-rule' },
      { datetime: T2, tag: 'wrong-rule' },
    ]);
  });

  it('does not treat a prose line that merely starts with ## as an entry', () => {
    // Only a bracketed ISO-UTC datetime header counts — human prose is safe.
    const text = `## [not-a-date] wrong-rule\n\n## a heading in prose\n`;
    expect(parseIncidents(text)).toEqual([]);
  });

  it('formatIncidentEntry emits a header line plus the trimmed prose body', () => {
    const block = formatIncidentEntry(T1, 'judges-blind', '   the reviewer could not see it   ');
    expect(block).toBe(`## [${T1}] judges-blind\n\nthe reviewer could not see it\n\n`);
  });

  it('formatIncidentEntry carries an aspect=<id> token ON THE HEADER when given', () => {
    const block = formatIncidentEntry(T1, 'wrong-rule', 'the rule missed it', 'ui-no-direct-db');
    // Attribution rides the header, ahead of the untouched prose body.
    expect(block).toBe(`## [${T1}] wrong-rule aspect=ui-no-direct-db\n\nthe rule missed it\n\n`);
  });

  it('formatIncidentEntry is byte-identical to the original header when unattributed', () => {
    // No aspect → the header is exactly `## [<iso>] <tag>`, no trailing token — an
    // unattributed entry is written exactly as before attribution existed.
    expect(formatIncidentEntry(T1, 'no-rule', 'x')).toBe(`## [${T1}] no-rule\n\nx\n\n`);
  });

  it('BACKWARD-COMPAT: an OLD header (no aspect= token) and a NEW header (aspect= token) both parse', () => {
    // The ledger is committed and long-lived: an entry written before per-rule
    // attribution existed carries a plain header and MUST still parse unchanged, while
    // a newer entry carries the header token — both in one file, in order.
    const text =
      `# Incident ledger\n\n` +
      `## [${T1}] wrong-rule\n\nan old entry, written before attribution existed\n\n` +
      `## [${T2}] wrong-rule aspect=input-validation\n\na new entry naming the miscalibrated rule\n\n`;
    const entries = parseIncidents(text);
    expect(entries).toEqual([
      { datetime: T1, tag: 'wrong-rule' }, // no aspect key — unattributed, as before
      { datetime: T2, tag: 'wrong-rule', aspect: 'input-validation' },
    ]);
  });

  it('SPOOF GUARD: an `aspect:` line in the reason BODY is inert — it never becomes attribution', () => {
    // The header carries NO attribution token, and a reason line that merely reads
    // `aspect: <rule>` must NOT be read as attribution — otherwise a free-text reason
    // could silently forge a rule name into that rule's per-rule health. The body is
    // never scanned; only the header's `aspect=` token attributes.
    const text =
      `## [${T1}] wrong-rule\n\nthe config broke\naspect: input-validation\nand it slipped\n\n`;
    const entries = parseIncidents(text);
    expect(entries).toEqual([{ datetime: T1, tag: 'wrong-rule' }]); // no aspect key
    expect(entries[0].aspect).toBeUndefined();
  });

  it('datetime + tag capture are unchanged by the optional trailing token (validator-safe)', () => {
    // The ascending-datetime validator reads only `.datetime`; the tag read is
    // group 2. Both must be identical whether or not an aspect= token trails.
    const plain = parseIncidents(`## [${T1}] wrong-rule\n\nr\n\n`);
    const tokened = parseIncidents(`## [${T1}] wrong-rule aspect=some-rule\n\nr\n\n`);
    expect(plain[0].datetime).toBe(T1);
    expect(tokened[0].datetime).toBe(T1);
    expect(plain[0].tag).toBe('wrong-rule');
    expect(tokened[0].tag).toBe('wrong-rule');
  });
});

describe('incidents-store — append / read / count round-trip', () => {
  it('creates the ledger with a preamble on first write, then appends only entries', () => {
    const root = freshRoot();
    try {
      expect(readIncidents(root)).toEqual({ entries: [], present: false });

      appendIncident(root, { tag: 'no-rule', reason: 'first escape', isoDatetime: T1 });
      const afterFirst = readFileSync(path.join(root, 'incidents.md'), 'utf-8');
      expect(afterFirst).toContain('# Incident ledger'); // one-time preamble
      expect(afterFirst).toContain(`## [${T1}] no-rule`);

      appendIncident(root, { tag: 'wrong-rule', reason: 'second escape', isoDatetime: T2 });
      const afterSecond = readFileSync(path.join(root, 'incidents.md'), 'utf-8');
      // Append-only: the preamble appears exactly once, both entries survive in order.
      expect(afterSecond.match(/# Incident ledger/g)).toHaveLength(1);

      const { entries, present } = readIncidents(root);
      expect(present).toBe(true);
      expect(entries).toEqual([
        { datetime: T1, tag: 'no-rule' },
        { datetime: T2, tag: 'wrong-rule' },
      ]);
    } finally {
      rmSync(path.dirname(root), { recursive: true, force: true });
    }
  });

  it('separates the new entry when a hand-edited ledger has no trailing newline', () => {
    const root = freshRoot();
    try {
      // The ledger is committed, human-editable testimony: a maintainer may hand-edit
      // it and leave the last line WITHOUT a trailing newline. Appending must still land
      // the new machine header on its own line — otherwise it glues onto the prose and
      // stops parsing, silently losing the tower's only external oracle signal.
      writeFileSync(
        path.join(root, 'incidents.md'),
        `# Incident ledger\n\n## [${T1}] no-rule\n\na hand-edited note without a trailing newline`,
        'utf-8',
      );

      appendIncident(root, { tag: 'wrong-rule', reason: 'newly recorded escape', isoDatetime: T2 });

      // The new header parses as a real, separate entry (not swallowed by the prose line).
      const { entries } = readIncidents(root);
      expect(entries).toEqual([
        { datetime: T1, tag: 'no-rule' },
        { datetime: T2, tag: 'wrong-rule' },
      ]);
      // On disk the header sits on its own line, and the original prose survives intact.
      const raw = readFileSync(path.join(root, 'incidents.md'), 'utf-8');
      expect(raw).toContain('a hand-edited note without a trailing newline\n## [');
      expect(raw).toContain(`## [${T2}] wrong-rule`);
    } finally {
      rmSync(path.dirname(root), { recursive: true, force: true });
    }
  });

  it('adds no extra separator when the ledger already ends in a newline (no over-fixing)', () => {
    const root = freshRoot();
    try {
      // A normally-appended ledger already ends in "\n\n"; a second append must not
      // introduce a spurious blank-line-only drift.
      appendIncident(root, { tag: 'no-rule', reason: 'first', isoDatetime: T1 });
      appendIncident(root, { tag: 'wrong-rule', reason: 'second', isoDatetime: T2 });
      const raw = readFileSync(path.join(root, 'incidents.md'), 'utf-8');
      expect(raw).not.toContain('\n\n\n');
    } finally {
      rmSync(path.dirname(root), { recursive: true, force: true });
    }
  });

  it('countIncidents tallies the total and the wrong-rule subset (absent ledger reads as 0/0)', () => {
    const root = freshRoot();
    try {
      expect(countIncidents(root)).toEqual({ total: 0, wrongRule: 0 });

      appendIncident(root, { tag: 'wrong-rule', reason: 'a', isoDatetime: T1 });
      appendIncident(root, { tag: 'no-rule', reason: 'b', isoDatetime: T2 });
      appendIncident(root, { tag: 'wrong-rule', reason: 'c', isoDatetime: T3 });

      expect(countIncidents(root)).toEqual({ total: 3, wrongRule: 2 });
    } finally {
      rmSync(path.dirname(root), { recursive: true, force: true });
    }
  });

  it('round-trips an attributed entry: appendIncident writes the aspect, readIncidents reads it back', () => {
    const root = freshRoot();
    try {
      appendIncident(root, {
        tag: 'wrong-rule',
        reason: 'the rule fired on the wrong site',
        isoDatetime: T1,
        aspect: 'ui-no-direct-db',
      });
      // A second, unattributed entry (no aspect) still appends and reads with no key.
      appendIncident(root, { tag: 'no-rule', reason: 'uncovered concern', isoDatetime: T2 });

      // On disk the attribution rides the header token; the plain entry keeps the bare
      // header, and neither writes an `aspect:` body line.
      const raw = readFileSync(path.join(root, 'incidents.md'), 'utf-8');
      expect(raw).toContain(`## [${T1}] wrong-rule aspect=ui-no-direct-db`);
      expect(raw).toContain(`## [${T2}] no-rule`);
      expect(raw).not.toContain('aspect: ui-no-direct-db');

      const { entries } = readIncidents(root);
      expect(entries).toEqual([
        { datetime: T1, tag: 'wrong-rule', aspect: 'ui-no-direct-db' },
        { datetime: T2, tag: 'no-rule' },
      ]);
    } finally {
      rmSync(path.dirname(root), { recursive: true, force: true });
    }
  });

  it('countWrongRuleIncidentsByAspect tallies only attributed wrong-rule incidents (honesty boundary)', () => {
    const root = freshRoot();
    try {
      // Absent ledger reads as an empty map.
      expect(countWrongRuleIncidentsByAspect(root)).toEqual(new Map());

      // Two wrong-rule incidents name rule-a; one names rule-b.
      appendIncident(root, { tag: 'wrong-rule', reason: 'a1', isoDatetime: T1, aspect: 'rule-a' });
      appendIncident(root, { tag: 'wrong-rule', reason: 'a2', isoDatetime: T2, aspect: 'rule-a' });
      appendIncident(root, { tag: 'wrong-rule', reason: 'b1', isoDatetime: T3, aspect: 'rule-b' });
      // An UNATTRIBUTED wrong-rule incident counts in the aggregate but NOT per-aspect.
      appendIncident(root, {
        tag: 'wrong-rule',
        reason: 'no rule named',
        isoDatetime: '2026-04-01T00:00:00.000Z',
      });
      // A non-wrong-rule tag with an aspect is allowed but is not miscalibration
      // evidence, so it never surfaces per-aspect.
      appendIncident(root, {
        tag: 'judges-blind',
        reason: 'blind spot',
        isoDatetime: '2026-05-01T00:00:00.000Z',
        aspect: 'rule-a',
      });

      expect(countWrongRuleIncidentsByAspect(root)).toEqual(
        new Map([
          ['rule-a', 2],
          ['rule-b', 1],
        ]),
      );
      // The aggregate still counts every wrong-rule incident, attributed or not.
      expect(countIncidents(root).wrongRule).toBe(4);
    } finally {
      rmSync(path.dirname(root), { recursive: true, force: true });
    }
  });
});

describe('checkIncidentLedger — ascending-datetime warning (non-blocking)', () => {
  it('is silent for an absent ledger (absence tolerated)', () => {
    const root = rootWithLedger(); // no incidents.md written
    try {
      expect(checkIncidentLedger(mkGraph(root))).toEqual([]);
    } finally {
      rmSync(path.dirname(root), { recursive: true, force: true });
    }
  });

  it('is silent when datetimes strictly ascend', () => {
    const root = rootWithLedger(
      `## [${T1}] no-rule\n\na\n\n## [${T2}] wrong-rule\n\nb\n\n## [${T3}] no-rule\n\nc\n\n`,
    );
    try {
      expect(checkIncidentLedger(mkGraph(root))).toEqual([]);
    } finally {
      rmSync(path.dirname(root), { recursive: true, force: true });
    }
  });

  it('warns (never errors) once per out-of-order transition, naming the offending header', () => {
    // Descending: T2 then T1.
    const root = rootWithLedger(`## [${T2}] no-rule\n\na\n\n## [${T1}] wrong-rule\n\nb\n\n`);
    try {
      const issues = checkIncidentLedger(mkGraph(root));
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('incident-ledger-out-of-order');
      expect(issues[0].severity).toBe('warning');
      expect(issues[0].messageData.what).toContain(T1);
      expect(issues[0].messageData.what).toContain('not strictly ascending');
    } finally {
      rmSync(path.dirname(root), { recursive: true, force: true });
    }
  });

  it('treats equal datetimes as not strictly ascending (one warning)', () => {
    const root = rootWithLedger(`## [${T1}] no-rule\n\na\n\n## [${T1}] wrong-rule\n\nb\n\n`);
    try {
      const issues = checkIncidentLedger(mkGraph(root));
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('incident-ledger-out-of-order');
    } finally {
      rmSync(path.dirname(root), { recursive: true, force: true });
    }
  });
});

describe('yg incident — command registration shape', () => {
  it('registers a single `incident` command with `add` and `read` subcommands', () => {
    const program = new Command();
    registerIncidentCommand(program);
    const incident = program.commands.find((c) => c.name() === 'incident');
    expect(incident).toBeDefined();
    const subNames = incident!.commands.map((c) => c.name()).sort();
    expect(subNames).toEqual(['add', 'read']);
  });
});
