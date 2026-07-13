/**
 * Integration tests for the committed LLM-fill event stream (RZ-14) wired into
 * the fill stage (core/fill.ts) via the config `events: { committed_llm: true }`
 * opt-in.
 *
 * Two invariants are pinned end-to-end against a real on-disk fixture project
 * (deterministic aspects only, so the whole test is keyless — no LLM provider):
 *
 *   - KEYLESS-CI ZERO-CHURN: a det-only fill with the opt-in ON leaves the
 *     committed events file BYTE-UNCHANGED (deterministic events never graduate).
 *   - G3 HASH-GUARD: the config `events` key never folds into any verdict hash —
 *     a fill under a config WITH the key and one WITHOUT it produce byte-identical
 *     lock inputHashes for every pair.
 */

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runFill } from '../../../src/core/fill.js';
import { readLock } from '../../../src/io/lock-store.js';
import { COMMITTED_EVENTS_FILENAME, EVENTS_FILENAME } from '../../../src/io/events-store.js';

const REVIEWER_CONFIG =
  'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n';

const DET_PASS = 'export function check(ctx) { void ctx; return []; }\n';
const DET_FAIL =
  'export function check(ctx) { void ctx; return [{ message: "bad", file: "src/svc.ts", line: 1 }]; }\n';

/**
 * Build a minimal, self-contained project with one `svc` node mapping `src/svc.ts`
 * and two deterministic aspects (one pass, one refuse). `extraConfig` is appended
 * to the base reviewer config so a caller can flip the `events` opt-in on/off.
 */
async function setupProject(extraConfig: string): Promise<{ projectRoot: string; yggRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-committed-events-'));
  const yggRoot = path.join(root, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'svc');
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), REVIEWER_CONFIG + extraConfig);
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

/** Map of `${aspectId} ${unitKey}` → inputHash for every verdict in the lock. */
function lockHashes(yggRootPath: string): Map<string, string> {
  const lock = readLock(yggRootPath);
  const out = new Map<string, string>();
  for (const [aspectId, units] of Object.entries(lock.verdicts)) {
    for (const [unitKey, entry] of Object.entries(units)) {
      if (entry?.hash !== undefined) out.set(`${aspectId} ${unitKey}`, entry.hash);
    }
  }
  return out;
}

describe('committed LLM-fill event stream (integration)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('keyless-CI zero-churn: a det-only fill with committed_llm ON leaves the committed events file BYTE-UNCHANGED', async () => {
    const { projectRoot, yggRoot } = await setupProject('events:\n  committed_llm: true\n');
    dirs.push(projectRoot);

    // Seed the committed events file with a sentinel; a det-only fill must not touch it.
    const committedPath = path.join(yggRoot, COMMITTED_EVENTS_FILENAME);
    const sentinel = '{"v":1,"ts":"2026-01-01T00:00:00.000Z","source":"fill","aspectId":"seed","unitKey":"node:seed","kind":"llm","disposition":"approved","hash":"seed"}\n';
    await writeFile(committedPath, sentinel, 'utf-8');
    const before = readFileSync(committedPath);

    const graph = await loadGraph(projectRoot);
    expect(graph.config.events?.committed_llm).toBe(true);
    await runFill(graph, { gitTrackedFiles: null, write: () => {}, onlyDeterministic: true });

    // Byte-identical: deterministic events never graduate to the committed stream.
    const after = readFileSync(committedPath);
    expect(after.equals(before)).toBe(true);

    // The deterministic events did land LOCALLY (proving the fill ran and emitted).
    const localRaw = await readFile(path.join(yggRoot, EVENTS_FILENAME), 'utf-8');
    expect(localRaw.split('\n').filter((l) => l.length > 0).length).toBeGreaterThanOrEqual(1);
  });

  it('G3 hash-guard: a config WITH the events key and one WITHOUT it produce identical pair inputHashes', async () => {
    const withKey = await setupProject('events:\n  committed_llm: true\n');
    const withoutKey = await setupProject('');
    dirs.push(withKey.projectRoot, withoutKey.projectRoot);

    const gWith = await loadGraph(withKey.projectRoot);
    const gWithout = await loadGraph(withoutKey.projectRoot);
    // Non-vacuity: the key was genuinely parsed on/off.
    expect(gWith.config.events?.committed_llm).toBe(true);
    expect(gWithout.config.events).toBeUndefined();

    await runFill(gWith, { gitTrackedFiles: null, write: () => {} });
    await runFill(gWithout, { gitTrackedFiles: null, write: () => {} });

    const hashesWith = lockHashes(gWith.rootPath);
    const hashesWithout = lockHashes(gWithout.rootPath);

    // Same pairs, byte-identical hashes — the events key never entered any hash.
    expect([...hashesWith.keys()].sort()).toEqual([...hashesWithout.keys()].sort());
    expect(hashesWith.size).toBeGreaterThanOrEqual(2);
    for (const [key, hash] of hashesWith) {
      expect(hashesWithout.get(key)).toBe(hash);
    }
  });
});
