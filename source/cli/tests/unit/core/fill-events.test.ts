/**
 * Integration tests for the append-only verdict-events telemetry sidecar
 * (io/events-store.ts) wired into the fill stage (core/fill.ts, spec §7).
 *
 * The sidecar is write-only local telemetry: nothing in the engine (check /
 * verify / render / fill) ever reads `.yg-events.jsonl` back. These tests only
 * assert what the fill appends, and where — never that anything consumes it.
 *
 * A minimal, self-contained project (two deterministic aspects, zero LLM
 * aspects) is enough to exercise both a real verdict (approved/refused) and
 * the --only-deterministic write-scope split, without needing to mock the LLM
 * provider factory or the structure runner.
 */

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runFill } from '../../../src/core/fill.js';
import { readLock } from '../../../src/io/lock-store.js';
import { EVENTS_FILENAME } from '../../../src/io/events-store.js';
import { ensureYggdrasilGitignore } from '../../../src/cli/init.js';

const REVIEWER_CONFIG =
  'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n';

const DET_PASS = 'export function check(ctx) { void ctx; return []; }\n';
const DET_FAIL = 'export function check(ctx) { void ctx; return [{ message: "bad", file: "src/svc.ts", line: 1 }]; }\n';
// A check that THROWS at runtime — the fill fails closed (no write) and emits a
// `runtime-error` disposition event for the pair.
const DET_THROW = 'export function check(ctx) { void ctx; throw new Error("boom in check.mjs"); }\n';

const SVC_SOURCE_DEFAULT = 'export const x = 1;\n';
// A source file carrying a MALFORMED yg-suppress marker (no reason). When a check
// returns a violation against this file, the runner collects its suppress ranges
// while filtering and throws — surfacing the fault as its own `malformed-suppress`
// disposition (NOT an aspect-check-runtime-error), which the fill emits as an event.
const SVC_SOURCE_MALFORMED_SUPPRESS =
  'export const x = 1;\n// yg-suppress(some-rule)\nexport const y = 2;\n';

/**
 * Build a minimal, self-contained project with one `svc` node mapping `src/svc.ts`
 * and one deterministic aspect per entry. Parametrized on the aspect rule sources
 * and the node's source file so a single harness covers the real-verdict happy path
 * AND the no-write infra dispositions (a crashing check, a malformed suppress marker).
 */
async function setupProjectWith(
  aspects: Array<{ id: string; rule: string }>,
  svcSource: string = SVC_SOURCE_DEFAULT,
): Promise<{ projectRoot: string; yggRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-fill-events-'));
  const yggRoot = path.join(root, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'svc');
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), REVIEWER_CONFIG);
  await writeFile(
    path.join(yggRoot, 'yg-architecture.yaml'),
    'node_types:\n  service:\n    description: s\n    log_required: false\n',
  );
  const aspectList = aspects.map((a) => `  - ${a.id}`).join('\n');
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    `name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc.ts\naspects:\n${aspectList}\n`,
  );
  await writeFile(path.join(root, 'src', 'svc.ts'), svcSource);

  for (const { id, rule } of aspects) {
    const aspDir = path.join(yggRoot, 'aspects', id);
    await mkdir(aspDir, { recursive: true });
    await writeFile(
      path.join(aspDir, 'yg-aspect.yaml'),
      `name: ${id}\ndescription: ${id} rule\nreviewer:\n  type: deterministic\nstatus: enforced\n`,
    );
    await writeFile(path.join(aspDir, 'check.mjs'), rule);
  }
  return { projectRoot: root, yggRoot };
}

async function setupProject(): Promise<{ projectRoot: string; yggRoot: string }> {
  return setupProjectWith([{ id: 'det-pass', rule: DET_PASS }, { id: 'det-fail', rule: DET_FAIL }]);
}

/** Read and parse the sidecar's JSONL lines for a project's `.yggdrasil/` root. */
async function readEvents(yggRootPath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path.join(yggRootPath, EVENTS_FILENAME), 'utf-8');
  return raw.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('verdict-events telemetry sidecar (integration)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('a fill appends one event per pair, each carrying the matching lock disposition', async () => {
    const { projectRoot } = await setupProject();
    dirs.push(projectRoot);
    const graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    const lock = readLock(graph.rootPath);
    const passEntry = lock.verdicts['det-pass']?.['node:svc'];
    const failEntry = lock.verdicts['det-fail']?.['node:svc'];
    expect(passEntry?.verdict).toBe('approved');
    expect(failEntry?.verdict).toBe('refused');

    // The sidecar lives directly inside .yggdrasil/ (graph.rootPath IS that dir).
    const eventsPath = path.join(graph.rootPath, EVENTS_FILENAME);
    expect(path.dirname(eventsPath)).toBe(graph.rootPath);
    const raw = await readFile(eventsPath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const passEvent = lines.find((e) => e.aspectId === 'det-pass');
    const failEvent = lines.find((e) => e.aspectId === 'det-fail');
    expect(passEvent).toMatchObject({
      v: 1,
      source: 'fill',
      kind: 'deterministic',
      unitKey: 'node:svc',
      disposition: 'approved',
      hash: passEntry?.hash,
    });
    // approved rationale is deliberately NOT recorded in v1.
    expect(passEvent?.reason).toBeUndefined();
    expect(failEvent).toMatchObject({
      v: 1,
      source: 'fill',
      kind: 'deterministic',
      unitKey: 'node:svc',
      disposition: 'refused',
      hash: failEntry?.hash,
      reason: failEntry?.reason,
    });
    // ts round-trips as a real ISO-8601 UTC string from the fill's own clock.
    expect(new Date(passEvent!.ts as string).toISOString()).toBe(passEvent!.ts);
  });

  it('--only-deterministic still appends telemetry events, but writes NO committed lock file', async () => {
    const { projectRoot, yggRoot } = await setupProject();
    dirs.push(projectRoot);
    // Same helper `yg init`/`--upgrade` runs to gitignore local Yggdrasil state —
    // confirms the sidecar's own filename is the one the CLI actually gitignores.
    await ensureYggdrasilGitignore(yggRoot);
    const gitignore = await readFile(path.join(yggRoot, '.gitignore'), 'utf-8');
    expect(gitignore).toContain(EVENTS_FILENAME);

    const graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {}, onlyDeterministic: true });

    // Telemetry is still recorded even in the free/keyless CI-gate mode.
    const eventsPath = path.join(graph.rootPath, EVENTS_FILENAME);
    const raw = await readFile(eventsPath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.some((e) => e.aspectId === 'det-pass' && e.disposition === 'approved')).toBe(true);

    // No COMMITTED lock file was written — only the gitignored det cache and the
    // gitignored events sidecar (both asserted above).
    for (const committed of ['yg-lock.nondeterministic.json', 'yg-lock.logs.json']) {
      let exists = true;
      try { await readFile(path.join(graph.rootPath, committed), 'utf-8'); } catch { exists = false; }
      expect(exists).toBe(false);
    }
  });

  // ── No-write infra dispositions (fail-closed). These emit sites in fill.ts were
  //    previously unasserted: a real verdict was covered above, but a crashing check
  //    and a malformed suppress marker each write NOTHING to the lock yet still emit
  //    exactly one telemetry event carrying their distinct disposition. The
  //    deterministic paths need no LLM mock. ──────────────────────────────────────

  it('a crashing check.mjs writes NO verdict but emits exactly one runtime-error event', async () => {
    const { projectRoot } = await setupProjectWith([{ id: 'det-throw', rule: DET_THROW }]);
    dirs.push(projectRoot);
    const graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    const events = await readEvents(graph.rootPath);
    const throwEvents = events.filter((e) => e.aspectId === 'det-throw');
    // Exactly ONE event for the pair, carrying the runtime-error disposition.
    expect(throwEvents).toHaveLength(1);
    expect(throwEvents[0]).toMatchObject({
      v: 1,
      source: 'fill',
      kind: 'deterministic',
      unitKey: 'node:svc',
      disposition: 'runtime-error',
    });
    // Fail-closed: NO verdict was written, so the event carries no inputHash/reason.
    expect(throwEvents[0].hash).toBeUndefined();
    expect(throwEvents[0].reason).toBeUndefined();
    // No approved/refused event was ever emitted for this pair.
    expect(events.some((e) => e.aspectId === 'det-throw' && (e.disposition === 'approved' || e.disposition === 'refused'))).toBe(false);
  });

  it('a violation against a file bearing a malformed suppress marker emits exactly one malformed-suppress event (not runtime-error)', async () => {
    // The check flags src/svc.ts:1; while filtering suppressions the runner parses
    // that file's markers, hits the reasonless yg-suppress marker, and fails closed
    // with a DISTINCT disposition — the fault is the source marker, not the check.
    const { projectRoot } = await setupProjectWith(
      [{ id: 'det-flag', rule: DET_FAIL }],
      SVC_SOURCE_MALFORMED_SUPPRESS,
    );
    dirs.push(projectRoot);
    const graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    const events = await readEvents(graph.rootPath);
    const flagEvents = events.filter((e) => e.aspectId === 'det-flag');
    // Exactly ONE event, carrying the malformed-suppress disposition — NOT the
    // runtime-error disposition (that would wrongly blame the check).
    expect(flagEvents).toHaveLength(1);
    expect(flagEvents[0]).toMatchObject({
      v: 1,
      source: 'fill',
      kind: 'deterministic',
      unitKey: 'node:svc',
      disposition: 'malformed-suppress',
    });
    expect(flagEvents[0].disposition).not.toBe('runtime-error');
    // Fail-closed: no verdict, so no inputHash.
    expect(flagEvents[0].hash).toBeUndefined();
  });
});
