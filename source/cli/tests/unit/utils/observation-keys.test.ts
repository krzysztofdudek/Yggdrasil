// The observation contract moved from core/pair-hash.ts into the pure
// utils/observation-keys.ts, with the digest injected by the caller. A stored
// deterministic verdict survives that move only if every observation value is
// byte-identical, so these tests hold the new code against the pre-move
// implementation (frozen verbatim below) over inputs taken from this repository's
// own graph and sources: every model directory's listing, every node id set, every
// graph file's bytes, and every rule config value.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  observationHashes,
  observationKey,
  codePointCanonicalJson,
  MISSING_OBSERVATION,
  type ObservationHashes,
} from '../../../src/utils/observation-keys.js';
import { normalizeLineEndings, SHA256_OBSERVATION_HASHES } from '../../../src/io/hash.js';
import {
  hashReadObservation,
  hashListObservation,
  hashExistsObservation,
  hashNodeSetObservation,
  hashFileSetObservation,
  hashConfigObservation,
} from '../../../src/core/pair-hash.js';
import { ObservationRecorder } from '../../../src/structure/observations.js';

// ---------------------------------------------------------------------------
// The pre-move implementation, frozen verbatim (core/pair-hash.ts before the
// split, with io/hash.ts's hashString/hashBytes inlined).
// ---------------------------------------------------------------------------
const legacyHashString = (s: string): string => createHash('sha256').update(s).digest('hex');
const legacyHashBytes = (b: Buffer): string => createHash('sha256').update(normalizeLineEndings(b)).digest('hex');
function legacyCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(legacyCanonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${legacyCanonicalJson(v)}`).join(',')}}`;
}
const legacy: ObservationHashes = {
  read: (bytes) => legacyHashBytes(bytes),
  list: (entries) =>
    legacyHashString(
      [...entries]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((e) => `${e.name}:${e.kind}`)
        .join('\n'),
    ),
  exists: (result) => legacyHashString(result === false ? 'false' : result),
  nodeSet: (ids) => legacyHashString([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join('\n')),
  fileSet: (paths) => legacyHashString([...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join('\n')),
  config: (value) => (value === undefined ? 'missing' : legacyHashString(legacyCanonicalJson(value))),
};

// ---------------------------------------------------------------------------
// A corpus drawn from this repository's own graph.
// ---------------------------------------------------------------------------
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../..');
const GRAPH_DIR = path.join(REPO_ROOT, '.yggdrasil');

interface Corpus {
  listings: Array<Array<{ name: string; kind: 'file' | 'dir' }>>;
  files: Buffer[];
  nodeIdSets: string[][];
  pathSets: string[][];
  configValues: unknown[];
}

function buildCorpus(): Corpus {
  const corpus: Corpus = { listings: [], files: [], nodeIdSets: [], pathSets: [], configValues: [] };
  const walk = (dir: string, rel: string): string[] => {
    const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.yg-lock'));
    corpus.listings.push(entries.map((e) => ({ name: e.name, kind: e.isDirectory() ? ('dir' as const) : ('file' as const) })));
    const childNodes: string[] = [];
    const files: string[] = [];
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        childNodes.push(childRel);
        walk(abs, childRel);
      } else {
        files.push(childRel);
        const bytes = readFileSync(abs);
        corpus.files.push(bytes);
        if (e.name === 'config.json') corpus.configValues.push(...Object.values(JSON.parse(bytes.toString('utf8')) as object));
      }
    }
    corpus.nodeIdSets.push(childNodes.reverse());
    corpus.pathSets.push([...files, ...files.slice(0, 1)].reverse());
    return childNodes;
  };
  walk(GRAPH_DIR, '');
  return corpus;
}

describe('observation-keys — byte-identical to the pre-move contract on the repo graph', () => {
  const corpus = buildCorpus();
  const hashes = observationHashes({
    text: (s) => createHash('sha256').update(s).digest('hex'),
    bytes: (b) => createHash('sha256').update(normalizeLineEndings(b)).digest('hex'),
  });

  it('draws a corpus that exercises every observation kind', () => {
    expect(statSync(path.join(GRAPH_DIR, 'model')).isDirectory()).toBe(true);
    expect(corpus.listings.length).toBeGreaterThan(100);
    expect(corpus.files.length).toBeGreaterThan(100);
    expect(corpus.configValues.length).toBeGreaterThan(0);
  });

  it('every value kind matches the frozen implementation', () => {
    for (const entries of corpus.listings) expect(hashes.list(entries)).toBe(legacy.list(entries));
    for (const bytes of corpus.files) expect(hashes.read(bytes)).toBe(legacy.read(bytes));
    for (const ids of corpus.nodeIdSets) expect(hashes.nodeSet(ids)).toBe(legacy.nodeSet(ids));
    for (const paths of corpus.pathSets) expect(hashes.fileSet(paths)).toBe(legacy.fileSet(paths));
    for (const value of [...corpus.configValues, undefined, 1, '1', null, { b: 1, a: [2, { d: undefined, c: 3 }] }]) {
      expect(hashes.config(value)).toBe(legacy.config(value));
      if (value !== undefined) expect(codePointCanonicalJson(value)).toBe(legacyCanonicalJson(value));
    }
    for (const result of ['file', 'dir', false] as const) expect(hashes.exists(result)).toBe(legacy.exists(result));
  });

  it('the injected sha256 binding and the engine exports fold the same values', () => {
    const sample = corpus.files.slice(0, 50);
    for (const bytes of sample) {
      expect(SHA256_OBSERVATION_HASHES.read(bytes)).toBe(legacy.read(bytes));
      expect(hashReadObservation(bytes)).toBe(legacy.read(bytes));
    }
    for (const entries of corpus.listings) expect(hashListObservation(entries)).toBe(legacy.list(entries));
    for (const ids of corpus.nodeIdSets) expect(hashNodeSetObservation(ids)).toBe(legacy.nodeSet(ids));
    for (const paths of corpus.pathSets) expect(hashFileSetObservation(paths)).toBe(legacy.fileSet(paths));
    for (const value of corpus.configValues) expect(hashConfigObservation(value)).toBe(legacy.config(value));
    expect(hashExistsObservation(false)).toBe(legacy.exists(false));
  });

  it('keys keep the `<kind>:<target>` spelling and the missing sentinel', () => {
    expect(observationKey('graph-files', 'cli/utils')).toBe('graph-files:cli/utils');
    expect(MISSING_OBSERVATION).toBe('missing');
  });

  it('the recorder hashes only through the digest it is handed', () => {
    const seen: string[] = [];
    const rec = new ObservationRecorder(
      observationHashes({
        text: (s) => {
          seen.push(s);
          return `t:${s}`;
        },
        bytes: (b) => `b:${b.toString('utf8')}`,
      }),
    );
    rec.recordRead('a.ts', Buffer.from('x'));
    rec.recordNodeFiles('cli/n', ['b', 'a', 'b']);
    rec.recordConfig('k', undefined);
    expect(rec.snapshot()).toEqual([
      ['config:k', MISSING_OBSERVATION],
      ['node-files:cli/n', 't:a\nb'],
      ['read:a.ts', 'b:x'],
    ]);
    expect(seen).toEqual(['a\nb']);
  });
});
