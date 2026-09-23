/**
 * Repo-wide invariants over this repository's own graph that no rule of the
 * graph can check about itself: which files its rule-script node owns, whether
 * two architecture types claim the same file, and whether a description still
 * talks about something that no longer exists or says a rule does not block
 * while it does.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { buildOwnerIndex } from '../../../src/relations/owner-index.js';
import { classifyFile } from '../../../src/core/type-classifier.js';
import { FileContentCache } from '../../../src/io/file-content-cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/unit/repo → repo root is five levels up: repo/unit/tests/cli/source.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const ASPECTS_ROOT = path.join(REPO_ROOT, '.yggdrasil', 'aspects');
const MODEL_ROOT = path.join(REPO_ROOT, '.yggdrasil', 'model');

function walkFiles(dir: string, keep: (rel: string) => boolean, skipDir: (name: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const visit = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        if (!skipDir(entry.name)) visit(child);
      } else {
        const rel = path.relative(REPO_ROOT, child).split(path.sep).join('/');
        if (keep(rel)) out.push(rel);
      }
    }
  };
  visit(dir);
  return out.sort();
}

describe('graph-rules owns every rule script this graph defines', () => {
  it('every non-drill check.mjs under .yggdrasil/aspects, at any depth, is mapped by graph-rules', async () => {
    const scripts = walkFiles(ASPECTS_ROOT, (rel) => rel.endsWith('/check.mjs'), (name) => name === 'drills');
    // Sanity: the walk reaches the nested ids (portal/<id>, reference/relations/<id>).
    expect(scripts).toContain('.yggdrasil/aspects/portal/loopback-only/check.mjs');
    expect(scripts).toContain('.yggdrasil/aspects/reference/relations/case-is-tested/check.mjs');

    const graph = await loadGraph(REPO_ROOT);
    const { ownerOf } = buildOwnerIndex(graph.nodes);
    const notOwned = scripts.filter((rel) => ownerOf(rel) !== 'graph-rules');
    expect(
      notOwned,
      `rule scripts graph-rules does not own — extend its mapping (and the rule-script type's when) to reach them: ${notOwned.join(', ')}`,
    ).toEqual([]);
  });

  it('no drill-case rule script is owned by graph-rules (they are fixtures, not the graph\'s rules)', async () => {
    const drillScripts = walkFiles(ASPECTS_ROOT, (rel) => rel.endsWith('/check.mjs') && rel.includes('/drills/'));
    expect(drillScripts.length).toBeGreaterThan(0);
    const graph = await loadGraph(REPO_ROOT);
    const { ownerOf } = buildOwnerIndex(graph.nodes);
    expect(drillScripts.filter((rel) => ownerOf(rel) === 'graph-rules')).toEqual([]);
  });
});

describe('architecture types classify disjointly', () => {
  it('no tracked file outside .yggdrasil/ matches the when of two types', async () => {
    const graph = await loadGraph(REPO_ROOT);
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf-8' })
      .split('\0')
      .filter((rel) => rel && !rel.startsWith('.yggdrasil/') && existsSync(path.join(REPO_ROOT, rel)));
    expect(tracked.length).toBeGreaterThan(500);
    const cache = new FileContentCache();
    const overlaps: string[] = [];
    for (const rel of tracked) {
      const { matches } = await classifyFile(path.join(REPO_ROOT, rel), rel, graph, cache);
      if (matches.length > 1) overlaps.push(`${rel}: ${matches.map((m) => m.typeId).join(' + ')}`);
    }
    expect(overlaps, `files two types' when both match — narrow one predicate:\n${overlaps.join('\n')}`).toEqual([]);
  });
});

describe('descriptions match what exists and how rules behave', () => {
  const describedFiles = [
    ...walkFiles(MODEL_ROOT, (rel) => rel.endsWith('/yg-node.yaml')),
    ...walkFiles(ASPECTS_ROOT, (rel) => rel.endsWith('/yg-aspect.yaml'), (name) => name === 'drills'),
  ];

  function descriptionOf(rel: string): string {
    const doc = parseYaml(readFileSync(path.join(REPO_ROOT, rel), 'utf-8')) as { description?: unknown } | null;
    return typeof doc?.description === 'string' ? doc.description : '';
  }

  it('no node or rule description describes the removed external-judge channel as if it still existed', () => {
    expect(describedFiles.length).toBeGreaterThan(400);
    const REMOVED = [/external[- ]judge/i, /\byg verdict\b/i];
    // A description that documents the removal itself (the hidden stub left in
    // the command's place, its tests) names the channel on purpose and says so.
    const offenders = describedFiles.filter((rel) => {
      const description = descriptionOf(rel);
      return REMOVED.some((re) => re.test(description)) && !/\bremoved\b/i.test(description);
    });
    expect(offenders, `descriptions still naming the removed external-judge channel: ${offenders.join(', ')}`).toEqual([]);
  });

  it('no enforced rule describes itself as never blocking', () => {
    const offenders = walkFiles(ASPECTS_ROOT, (rel) => rel.endsWith('/yg-aspect.yaml'), (name) => name === 'drills').filter((rel) => {
      const doc = parseYaml(readFileSync(path.join(REPO_ROOT, rel), 'utf-8')) as { status?: unknown; description?: unknown } | null;
      const status = doc?.status ?? 'enforced';
      return status === 'enforced' && typeof doc?.description === 'string' && /never blocks/i.test(doc.description);
    });
    expect(offenders, `enforced rules whose description says they never block: ${offenders.join(', ')}`).toEqual([]);
  });
});
