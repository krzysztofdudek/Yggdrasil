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
