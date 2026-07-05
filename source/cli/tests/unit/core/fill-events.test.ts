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

async function setupProject(): Promise<{ projectRoot: string; yggRoot: string }> {
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
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc.ts\naspects:\n  - det-pass\n  - det-fail\n',
  );
  await writeFile(path.join(root, 'src', 'svc.ts'), 'export const x = 1;\n');

  for (const [id, rule] of [['det-pass', DET_PASS], ['det-fail', DET_FAIL]] as const) {
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
});
