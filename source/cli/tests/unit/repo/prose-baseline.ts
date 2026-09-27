// The prose-assertion counts of the end-to-end tests and their committed
// baseline, shared by the ratchet that checks them (e2e-prose-ratchet.test.ts)
// and the command that lowers the baseline (generated-files.update.ts, run by
// `npm run prose:baseline`). Reads files only; writes nothing.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProseAssertions } from '../../support/prose-assertions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESTS_ROOT = path.resolve(__dirname, '..', '..');
export const E2E_ROOT = path.join(TESTS_ROOT, 'e2e');
export const BASELINE_PATH = path.join(__dirname, 'e2e-prose-baseline.json');

/**
 * End-to-end files whose subject is the wording itself, so a sentence is the
 * right thing to assert: the golden corpus comparison, and the docs samples
 * that must match a real run character for character.
 */
const WORDING_CONTRACT = new Set(['cli-golden-corpus.test.ts', 'docs-output-samples.test.ts']);

export interface Baseline {
  description: string;
  files: Record<string, number>;
}

function e2eTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) e2eTestFiles(p, out);
    else if (entry.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** Per end-to-end file outside WORDING_CONTRACT: its prose assertions, counted and listed with their lines. */
export function currentCounts(): Map<string, { count: number; lines: string[] }> {
  const counts = new Map<string, { count: number; lines: string[] }>();
  for (const file of e2eTestFiles(E2E_ROOT).sort()) {
    const rel = path.relative(E2E_ROOT, file).split(path.sep).join('/');
    if (WORDING_CONTRACT.has(rel)) continue;
    const found = findProseAssertions(readFileSync(file, 'utf-8'));
    if (found.length === 0) continue;
    counts.set(rel, { count: found.length, lines: found.map((f) => `  ${rel}:${f.line}  ${f.matcher}(${JSON.stringify(f.literal)})`) });
  }
  return counts;
}

export function readBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as Baseline;
}

/**
 * The baseline file's text with every count lowered to what the files hold
 * now. It never raises a count and never adds a file, so a file over its
 * baseline still fails the ratchet after the update.
 */
export function loweredBaselineText(before: Baseline, counts: Map<string, { count: number }>): string {
  const lowered: Record<string, number> = {};
  for (const [rel, allowed] of Object.entries(before.files)) {
    const now = counts.get(rel)?.count ?? 0;
    if (now > 0) lowered[rel] = Math.min(now, allowed);
  }
  return `${JSON.stringify({ description: before.description, files: lowered }, null, 2)}\n`;
}
