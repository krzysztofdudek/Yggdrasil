/**
 * Parity test for the deterministic worker-thread fill path (fill.ts step 5).
 *
 * The deterministic phase now runs across worker threads when `detConcurrency > 1`.
 * This test proves the parallel path produces BYTE-IDENTICAL results to the
 * sequential (in-process) path: same lock verdicts (verdict + hash + reason),
 * same grouped diagnostics, same counts. Two identical temp projects are filled —
 * one with detConcurrency 1 (sequential), one with 4 (a real worker pool,
 * independent of the host core count) — and their outcomes compared.
 *
 * No mocking: real check.mjs, real graph load, real worker threads. `--only-
 * deterministic` keeps it hermetic (no LLM reviewer). Requires the built
 * dist/det-worker.js (repo-check builds before it tests).
 */

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runFill } from '../../../src/core/fill.js';
import { readLock } from '../../../src/io/lock-store.js';
import { buildIssueMessage } from '../../../src/formatters/message-builder.js';
import type { IssueMessage } from '../../../src/model/validation.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

// A per-file deterministic check: files whose name contains "bad" are refused,
// the rest approved — a mix of verdicts across several pairs.
const PER_FILE_CHECK =
  `export function check(ctx) {\n` +
  `  const f = ctx.subject[0];\n` +
  `  if (f && f.path.includes('bad')) return [{ message: 'no bad files', file: f.path, line: 1 }];\n` +
  `  return [];\n` +
  `}\n`;

// A per-file check that THROWS on "bad" files — those pairs become runtime-error
// dispositions (no write), exercising the parallel path's grouped-diagnostic
// collection + deterministic (pair-order) flattening, not just clean verdicts.
const PER_FILE_THROW =
  `export function check(ctx) {\n` +
  `  const f = ctx.subject[0];\n` +
  `  if (f && f.path.includes('bad')) throw new Error('boom in ' + f.path);\n` +
  `  return [];\n` +
  `}\n`;

// Enough files that the pool actually engages: the fill pool needs
// floor(activePairs / MIN_DET_PAIRS_PER_WORKER=8) >= 2, i.e. >= 16 pairs, before
// it spawns workers (a small fill stays in-process — that guard is what this
// suite must run ON THE FAR SIDE of, so it exercises the real worker path). 14
// clean + 6 "bad" = 20 per-file pairs.
const CLEAN_FILES = Array.from({ length: 14 }, (_, i) => `src/ok${i}.ts`);
const BAD_FILES = Array.from({ length: 6 }, (_, i) => `src/bad${i}.ts`);
const FILES = [...CLEAN_FILES, ...BAD_FILES];

async function buildProject(checkBody: string = PER_FILE_CHECK): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-det-parallel-'));
  dirs.push(root);
  const ygg = path.join(root, '.yggdrasil');
  await mkdir(path.join(ygg, 'model', 'svc'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(ygg, 'yg-config.yaml'), 'version: 5\n');
  await writeFile(
    path.join(ygg, 'yg-architecture.yaml'),
    'node_types:\n  service:\n    description: s\n',
  );
  await writeFile(
    path.join(ygg, 'model', 'svc', 'yg-node.yaml'),
    `name: svc\ntype: service\ndescription: x\nmapping:\n${FILES.map((f) => `  - ${f}`).join('\n')}\naspects:\n  - per-file-rule\n`,
  );
  for (const f of FILES) await writeFile(path.join(root, f), 'export const x = 1;\n');
  const aspDir = path.join(ygg, 'aspects', 'per-file-rule');
  await mkdir(aspDir, { recursive: true });
  await writeFile(
    path.join(aspDir, 'yg-aspect.yaml'),
    'name: per-file-rule\ndescription: no bad files\nreviewer:\n  type: deterministic\nscope:\n  per: file\n',
  );
  await writeFile(path.join(aspDir, 'check.mjs'), checkBody);
  return root;
}

function makeSink(): { emit: (m: IssueMessage) => void; text: () => string } {
  let buf = '';
  return { emit: (m) => { buf += buildIssueMessage(m) + '\n'; }, text: () => buf };
}

describe('deterministic fill parity: sequential vs worker pool', () => {
  it('detConcurrency 1 and 4 produce identical verdicts, diagnostics and counts', async () => {
    const rootSeq = await buildProject();
    const rootPar = await buildProject();

    const graphSeq = await loadGraph(rootSeq);
    const sinkSeq = makeSink();
    const resSeq = await runFill(graphSeq, {
      gitTrackedFiles: null, onlyDeterministic: true, detConcurrency: 1,
      write: () => {}, emitIssue: sinkSeq.emit,
    });

    const graphPar = await loadGraph(rootPar);
    const sinkPar = makeSink();
    const resPar = await runFill(graphPar, {
      gitTrackedFiles: null, onlyDeterministic: true, detConcurrency: 4,
      write: () => {}, emitIssue: sinkPar.emit,
    });

    // Verdicts are keyed by aspectId → unitKey (root-independent) → entry.
    const verdictsSeq = readLock(graphSeq.rootPath).verdicts;
    const verdictsPar = readLock(graphPar.rootPath).verdicts;

    // Sanity: the fill produced the expected mix (BAD_FILES refused, CLEAN_FILES approved).
    const entries = Object.values(verdictsPar['per-file-rule'] ?? {});
    expect(entries).toHaveLength(FILES.length);
    expect(entries.filter((e) => e.verdict === 'refused')).toHaveLength(BAD_FILES.length);
    expect(entries.filter((e) => e.verdict === 'approved')).toHaveLength(CLEAN_FILES.length);

    // Parity: identical verdicts (verdict + content hash + reason), diagnostics, counts.
    expect(verdictsPar).toEqual(verdictsSeq);
    expect(sinkPar.text()).toBe(sinkSeq.text());
    expect(resPar.runtimeErrors).toBe(resSeq.runtimeErrors);
    expect(resPar.malformedSuppressErrors).toBe(resSeq.malformedSuppressErrors);
  }, 30000);

  it('runtime-error dispositions group identically in the parallel path (order-independent)', async () => {
    // The parallel path collects runtime-error dispositions into index-keyed slots
    // and flattens them in PAIR order before grouping — so the grouped diagnostic
    // text must not depend on which worker finished first. Compare a sequential
    // fill against a 4-worker fill of an identical project whose check THROWS on
    // half the files.
    const rootSeq = await buildProject(PER_FILE_THROW);
    const rootPar = await buildProject(PER_FILE_THROW);

    const graphSeq = await loadGraph(rootSeq);
    const sinkSeq = makeSink();
    const resSeq = await runFill(graphSeq, {
      gitTrackedFiles: null, onlyDeterministic: true, detConcurrency: 1,
      write: () => {}, emitIssue: sinkSeq.emit,
    });

    const graphPar = await loadGraph(rootPar);
    const sinkPar = makeSink();
    const resPar = await runFill(graphPar, {
      gitTrackedFiles: null, onlyDeterministic: true, detConcurrency: 4,
      write: () => {}, emitIssue: sinkPar.emit,
    });

    // Sanity: the throwing path was exercised (one runtime-error per BAD file), and
    // the clean files still recorded approved verdicts.
    expect(resSeq.runtimeErrors).toBe(BAD_FILES.length);
    expect(Object.values(readLock(graphPar.rootPath).verdicts['per-file-rule'] ?? {})).toHaveLength(CLEAN_FILES.length);

    // Parity of counts and clean verdicts.
    expect(resPar.runtimeErrors).toBe(resSeq.runtimeErrors);
    expect(readLock(graphPar.rootPath).verdicts).toEqual(readLock(graphSeq.rootPath).verdicts);

    // The deterministic-ordering guarantee: the failing units appear in the SAME
    // pair order regardless of which worker finished first. (Compare the ORDERED
    // unit list, not the full text — a runtime-error notice embeds the thrown
    // error's stack trace, whose internal frames legitimately differ between the
    // in-process runner and the worker bundle; the ORDER is the invariant.)
    const failedUnits = (text: string): string[] =>
      [...text.matchAll(/failed to run on (file:\S+)/g)].map((m) => m[1]);
    expect(failedUnits(sinkPar.text())).toEqual(failedUnits(sinkSeq.text()));
    // Every BAD file failed, exactly once (order-independent set check).
    expect([...failedUnits(sinkSeq.text())].sort()).toEqual(BAD_FILES.map((f) => `file:${f}`).sort());
  }, 30000);
});
