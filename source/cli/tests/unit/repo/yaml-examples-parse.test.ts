// =============================================================================
// GUARD — every YAML example in the docs and the knowledge topics parses
// through the real parser of the file it shows.
//
// An example is a ```yaml block, or each part of one that several file-naming
// comments split. It is taken to show one of the file formats in
// utils/file-formats.ts when a comment in it names the file (`#
// .yggdrasil/flows/checkout/yg-flow.yaml`, and `# yg-architecture.yaml,
// node_types.command.aspects` for an excerpt of one block), or else when one of
// its top-level keys is a key only file formats declare (a `name:` or
// `description:` alone says nothing — plenty of YAML has those); a block that is
// a `when:` alone is a predicate of either grammar. A fragment is completed with
// what its format requires and the excerpt leaves out (a node's name and type,
// a node type's or a port's description, a package's schema line, the
// configuration a secrets overlay or an adaptation sits on, …) and then parsed
// with the REAL parser; when its keys fit several formats it must parse as at
// least one of them. So a documented key the parser refuses, a misspelled key,
// or a value of the wrong type in an example fails here, by page and line.
//
// A grammar sketch — a block with `<placeholder>` values — is not a file and is
// skipped. Any other block that is deliberately not a valid file is listed in
// NOT_A_FILE with the reason.
//
// The annotated example of every file format (`yg schemas read <name>`) is
// held to the same parse, as one whole example keyed `schema <name>`.
//
// Hermetic: temporary directories only; no CLI process, no network.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { FILE_FORMATS } from '../../../src/utils/file-formats.js';
import { keysOf } from '../../../src/utils/file-schema.js';
import { KNOWLEDGE_TOPICS } from '../../../src/templates/knowledge/index.js';
import { SCHEMA_TOPICS } from '../../../src/templates/schemas/index.js';
import { parseNodeYaml } from '../../../src/io/node-parser.js';
import { parseArchitecture } from '../../../src/io/architecture-parser.js';
import { parseAspect } from '../../../src/io/aspect-parser.js';
import { parseFlow } from '../../../src/io/flow-parser.js';
import { parseConfigDetailed } from '../../../src/io/config-parser.js';
import { parseMarketplaceManifest, parsePackageManifest, parsePackagesLock } from '../../../src/io/package-manifest-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');

type Doc = Record<string, unknown>;

/** The file a comment names, and the format it is. */
const FILE_NAMES: Array<[RegExp, string]> = [
  [/yg-aspect\.adapt\.yaml/, 'aspect-adapt'],
  [/yg-node\.yaml/, 'node'],
  [/yg-aspect\.yaml/, 'aspect'],
  [/yg-architecture\.yaml/, 'architecture'],
  [/yg-config\.yaml/, 'config'],
  [/yg-secrets\.yaml/, 'secrets'],
  [/yg-flow\.yaml/, 'flow'],
  [/yg-package\.yaml/, 'package'],
  [/yg-marketplace\.yaml/, 'marketplace'],
  [/yg-packages\.yaml/, 'packages'],
];

/** Top-level keys too common in YAML at large to say which file an example is. */
const GENERIC_KEYS = new Set(['name', 'description', 'version', 'type', 'config', 'aspects', 'packages', 'schema']);

/**
 * Blocks that are not a whole or partial file of any format, keyed
 * `<page>:<line of the opening fence>`, each with the reason.
 */
const NOT_A_FILE: Record<string, string> = {};

interface Example {
  where: string;
  text: string;
}

/** A comment line that names a graph file. */
const NAMES_A_FILE = /^\s*#.*\byg-[\w.]+\.yaml/;

function yamlBlocks(where: string, text: string): Example[] {
  const out: Example[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*```ya?ml\s*$/.test(lines[i])) continue;
    const indent = lines[i].match(/^\s*/)![0].length;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !/^\s*```\s*$/.test(lines[j]); j++) body.push(lines[j].slice(Math.min(indent, lines[j].match(/^\s*/)![0].length)));
    // One block showing several files, each introduced by a comment naming it,
    // is several examples.
    const starts = body.map((l, k) => (/^#/.test(l) && NAMES_A_FILE.test(l) ? k : -1)).filter((k) => k >= 0);
    if (starts.length <= 1) out.push({ where: `${where}:${i + 1}`, text: body.join('\n') });
    else {
      if (body.slice(0, starts[0]).some((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))) out.push({ where: `${where}:${i + 1}`, text: body.slice(0, starts[0]).join('\n') });
      starts.forEach((k, n) => out.push({ where: `${where}:${i + 2 + k}`, text: body.slice(k, starts[n + 1] ?? body.length).join('\n') }));
    }
    i = j;
  }
  return out;
}

/** True for a grammar sketch: a `<placeholder>` used as a value or a key, outside comments. */
function isSketch(text: string): boolean {
  return text.split('\n').some((l) => /<[a-z][\w-]*>|<clause>/.test(l.replace(/#.*$/, '')));
}

function allExamples(): Example[] {
  const out: Example[] = [];
  const docs = path.join(REPO_ROOT, 'docs');
  for (const f of readdirSync(docs).filter((n) => n.endsWith('.md')).sort()) out.push(...yamlBlocks(`docs/${f}`, readFileSync(path.join(docs, f), 'utf-8')));
  for (const [name, topic] of Object.entries(KNOWLEDGE_TOPICS)) out.push(...yamlBlocks(`knowledge ${name}`, topic.content));
  // The annotated example `yg schemas read <name>` prints is one whole file of
  // its format, not a fenced block: its first comment names the file.
  for (const [name, topic] of Object.entries(SCHEMA_TOPICS)) out.push({ where: `schema ${name}`, text: topic.content });
  return out;
}

/** The first comment naming a graph file: the format, and the block path an excerpt sits at. */
function fileHint(text: string): { format: string; at: string[] } | undefined {
  const comment = text.split('\n').find((l) => NAMES_A_FILE.test(l));
  if (comment === undefined) return undefined;
  const format = FILE_NAMES.find(([re]) => re.test(comment))?.[1];
  if (format === undefined) return undefined;
  const at = /yg-[\w.]+\.yaml\s*,\s*([\w.*-]+)/.exec(comment)?.[1].split('.') ?? [];
  return { format, at };
}

/** The formats an example may be, or [] when it is not an example of any. */
function candidates(ex: Example, doc: unknown): string[] {
  const hint = fileHint(ex.text);
  if (hint !== undefined) return [hint.format];
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return [];
  const keys = Object.keys(doc as object);
  if (keys.length === 1 && keys[0] === 'when') return ['aspect', 'type-when'];
  const distinctive = keys.filter((k) => !GENERIC_KEYS.has(k));
  if (distinctive.length === 0) return [];
  return FILE_FORMATS.filter((f) => distinctive.some((k) => keysOf(f.root).includes(k))).map((f) => f.name);
}

/**
 * The example as a whole file: an excerpt put back at the block its comment
 * names, and what the format requires that an excerpt leaves out.
 */
function completed(format: string, doc: Doc, at: string[]): Doc {
  // `# yg-architecture.yaml, node_types.command.aspects` over `aspects: [...]`:
  // the block's own key is the last step, so it sits under the steps before it.
  let whole: Doc = doc;
  const outer = at.length > 0 && Object.keys(doc).length === 1 && Object.keys(doc)[0] === at[at.length - 1] ? at.slice(0, -1) : at;
  for (const step of [...outer].reverse()) whole = { [step]: whole };
  if (format === 'type-when') whole = { node_types: { example: { when: doc.when } } };
  const fill: Record<string, Doc> = {
    node: { name: 'Example', type: 'service' },
    aspect: { name: 'Example' },
    flow: { name: 'Example', nodes: ['example'] },
    package: { schema: 'yg-package/1', name: 'example', version: '1.0.0', requires: { yg: '6.x' }, aspects: Object.keys((whole.config as Doc | undefined) ?? {}) },
    marketplace: { schema: 'yg-marketplace/1', packages: [] },
    packages: { schema: 'yg-packages/1' },
  };
  const out: Doc = { ...(fill[format] ?? {}), ...whole };
  // A node type's and a port's description are required, and an excerpt about
  // something else leaves them out.
  for (const entry of Object.values((out.node_types as Record<string, Doc> | undefined) ?? {})) if (entry !== null && typeof entry === 'object' && entry.description === undefined) entry.description = 'Example.';
  for (const [name, entry] of Object.entries((out.ports as Record<string, Doc> | undefined) ?? {})) if (name !== 'default' && entry !== null && typeof entry === 'object' && entry.description === undefined) entry.description = 'Example.';
  return out;
}

let root: string;
let counter = 0;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'yg-yaml-examples-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Parse `doc` as `format` with the real parser: undefined when accepted, else why not. */
async function refusal(format: string, doc: Doc): Promise<string | undefined> {
  const dir = path.join(root, `case-${counter++}`);
  await mkdir(dir, { recursive: true });
  const file = (name: string) => path.join(dir, name);
  try {
    switch (format) {
      case 'node':
        await writeFile(file('yg-node.yaml'), stringify(doc));
        await parseNodeYaml(file('yg-node.yaml'));
        return undefined;
      case 'architecture':
      case 'type-when':
        await writeFile(file('yg-architecture.yaml'), stringify(doc));
        await parseArchitecture(file('yg-architecture.yaml'));
        return undefined;
      case 'flow':
        await writeFile(file('yg-flow.yaml'), stringify(doc));
        await parseFlow(dir, file('yg-flow.yaml'));
        return undefined;
      case 'aspect':
      case 'aspect-adapt': {
        const aspectDir = path.join(dir, '.yggdrasil', 'aspects', 'rule');
        await mkdir(aspectDir, { recursive: true });
        const own = format === 'aspect' ? doc : { name: 'Example', reviewer: { type: 'llm' } };
        const kind = (own.reviewer as { type?: string } | undefined)?.type;
        if (kind === 'deterministic') await writeFile(path.join(aspectDir, 'check.mjs'), 'export function check() { return []; }\n');
        else if (kind !== 'aggregate') await writeFile(path.join(aspectDir, 'content.md'), '# rule\n');
        await writeFile(path.join(aspectDir, 'yg-aspect.yaml'), stringify(own));
        if (format === 'aspect-adapt') await writeFile(path.join(aspectDir, 'yg-aspect.adapt.yaml'), stringify(doc));
        // A companion the example names, and the package settings its config sets.
        if (typeof doc.companion === 'string') {
          await mkdir(path.dirname(path.join(dir, doc.companion)), { recursive: true });
          await writeFile(path.join(dir, doc.companion), 'export default () => [];\n');
        }
        const config = (doc.config ?? {}) as Record<string, string | number | boolean>;
        const pkg = Object.keys(config).length === 0 ? undefined : {
          packageName: 'example', idPrefix: 'packages/o/r/example', aspectDirs: ['rule'], relativeId: 'rule',
          configSchema: Object.fromEntries(Object.entries(config).map(([k, v]) => [k, { type: typeof v as 'string' | 'number' | 'boolean', default: v }])),
        };
        const r = await parseAspect(aspectDir, path.join(aspectDir, 'yg-aspect.yaml'), 'rule', { projectRoot: dir, ...(pkg && { package: pkg }) });
        return r.ok ? undefined : r.errors.map((e) => `${e.code}: ${e.messageData.what}`).join('; ');
      }
      case 'config':
      case 'secrets': {
        if (format === 'config') await writeFile(file('yg-config.yaml'), stringify(doc));
        else {
          // The overlay sits on a committed file that declares the tiers it tunes.
          const tiers = Object.keys(((doc.reviewer as Doc | undefined)?.tiers as Doc | undefined) ?? {});
          const committed: Doc = { version: '6.1.0', ...(tiers.length > 0 && { reviewer: { ...(tiers.length > 1 && { default: tiers[0] }), tiers: Object.fromEntries(tiers.map((t) => [t, { provider: 'claude-code', consensus: 1, config: {} }])) } }) };
          await writeFile(file('yg-config.yaml'), stringify(committed));
          await writeFile(file('yg-secrets.yaml'), stringify(doc));
        }
        const r = await parseConfigDetailed(file('yg-config.yaml'));
        return r.unknownKeys.length === 0 ? undefined : `unknown key ${r.unknownKeys.map((u) => `'${u.key}'`).join(', ')}`;
      }
      case 'package': {
        await writeFile(file('yg-package.yaml'), stringify(doc));
        const r = await parsePackageManifest(file('yg-package.yaml'));
        return r.ok ? undefined : r.errors[0].messageData.what;
      }
      case 'marketplace': {
        await writeFile(file('yg-marketplace.yaml'), stringify(doc));
        const r = await parseMarketplaceManifest(file('yg-marketplace.yaml'));
        return r.ok ? undefined : r.errors[0].messageData.what;
      }
      case 'packages': {
        await writeFile(file('yg-packages.yaml'), stringify(doc));
        const r = await parsePackagesLock(file('yg-packages.yaml'));
        return r.ok ? undefined : r.errors[0].messageData.what;
      }
      default:
        return `no parser wired for format '${format}'`;
    }
  } catch (err) {
    return (err as Error).message.split('\n')[0];
  }
}

describe('every YAML example in the docs and the knowledge topics parses', () => {
  it('finds examples of every format it can check', () => {
    const seen = new Set<string>();
    for (const ex of allExamples()) {
      let doc: unknown;
      try {
        doc = parse(ex.text);
      } catch {
        continue;
      }
      for (const c of candidates(ex, doc)) seen.add(c);
    }
    // Every format but the local overlay has an example somewhere.
    expect([...seen].sort()).toEqual(expect.arrayContaining(['architecture', 'aspect', 'aspect-adapt', 'config', 'flow', 'node', 'package']));
  });

  it('each example parses through the real parser of the file it shows', async () => {
    const failures: string[] = [];
    for (const ex of allExamples()) {
      if (NOT_A_FILE[ex.where] !== undefined) continue;
      let doc: unknown;
      try {
        doc = parse(ex.text);
      } catch (err) {
        // Not YAML at all: only a problem when the block names a graph file.
        if (FILE_NAMES.some(([re]) => re.test(ex.text))) failures.push(`${ex.where}: does not parse as YAML: ${(err as Error).message.split('\n')[0]}`);
        continue;
      }
      const formats = candidates(ex, doc);
      if (formats.length === 0 || isSketch(ex.text)) continue;
      const at = fileHint(ex.text)?.at ?? [];
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
        failures.push(`${ex.where}: names ${formats[0]} but is not a mapping`);
        continue;
      }
      const why: string[] = [];
      for (const format of formats) {
        const r = await refusal(format, completed(format, doc as Doc, at));
        if (r === undefined) {
          why.length = 0;
          break;
        }
        why.push(`as ${format}: ${r}`);
      }
      if (why.length > 0) failures.push(`${ex.where}: ${why.join(' | ')}`);
    }
    expect(failures, 'a YAML example the real parser refuses — fix the example, or list it in NOT_A_FILE with the reason').toEqual([]);
  });

  it('checks the annotated example of every file format, none skipped as a sketch', () => {
    const skipped: string[] = [];
    for (const ex of allExamples().filter((e) => e.where.startsWith('schema '))) {
      const name = ex.where.slice('schema '.length);
      const formats = candidates(ex, parse(ex.text));
      if (NOT_A_FILE[ex.where] !== undefined || isSketch(ex.text) || !formats.includes(name)) skipped.push(ex.where);
    }
    expect(skipped).toEqual([]);
  });

  it('lists in NOT_A_FILE only blocks that exist', () => {
    const where = new Set(allExamples().map((e) => e.where));
    expect(Object.keys(NOT_A_FILE).filter((w) => !where.has(w))).toEqual([]);
  });
});
