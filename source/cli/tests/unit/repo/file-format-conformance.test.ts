// =============================================================================
// GUARD — every file format's parser enforces the schema `yg schemas read`
// prints and the docs field tables are generated from.
//
// For each of the ten formats in utils/file-formats.ts this test writes a full
// valid document, parses it with the REAL parser, and then, for every field the
// schema declares, writes the same document with that one value replaced by a
// value of the wrong type — and for every closed mapping, with one unknown key
// added — and asserts the real parser refuses it. A schema that declares a key
// the parser ignores, a type the parser does not check, or a mapping the parser
// lets any key into fails here, by path.
//
// Hermetic: temporary directories only; no CLI process, no network.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { FILE_FORMATS } from '../../../src/utils/file-formats.js';
import { fieldRows, type FieldType, type FileFormatSchema, type ObjectType } from '../../../src/utils/file-schema.js';
import { parseNodeYaml } from '../../../src/io/node-parser.js';
import { parseArchitecture } from '../../../src/io/architecture-parser.js';
import { parseAspect } from '../../../src/io/aspect-parser.js';
import { parseFlow } from '../../../src/io/flow-parser.js';
import { parseConfigDetailed } from '../../../src/io/config-parser.js';
import { parseMarketplaceManifest, parsePackageManifest, parsePackagesLock } from '../../../src/io/package-manifest-parser.js';

type Doc = Record<string, unknown>;

/** A predicate each grammar accepts. */
const NODE_WHEN = { node: { type: 'service' } };
const FILE_WHEN = { path: 'src/**' };

const CONFIG_DOC: Doc = {
  version: '6.1.0',
  quality: { max_direct_relations: 10 },
  reviewer: {
    default: 'standard',
    tiers: {
      standard: {
        provider: 'openai-compatible',
        consensus: 1,
        max_prompt_chars: 50000,
        config: { model: 'm', endpoint: 'http://localhost:1', temperature: 0, timeout: 30, api_key: 'k' },
      },
    },
  },
  parallel: 2,
  debug: false,
  auto_approve: 'deterministic',
  signals: { attention: true },
  events: { committed_llm: false },
  coverage: { required: ['/'], excluded: [], type_level: false },
  progressive: { reference: 'origin/main' },
  rules_artifacts: { agents_md: true, claude_md: true, clinerules: true },
};

const ASPECT_DOC: Doc = {
  name: 'A',
  description: 'd',
  reviewer: { type: 'llm', tier: 'deep' },
  status: 'advisory',
  review_by: '2027-01-31',
  errs: 'under',
  implies: [{ id: 'other', when: NODE_WHEN, status_inherit: 'strictest' }],
  when: NODE_WHEN,
  references: [{ path: 'ref.md', description: 'r' }],
  scope: { per: 'file', files: FILE_WHEN },
  companion: 'comp.mjs',
  config: {},
};

/** Full valid documents per format; a field's mutation uses the first one that has the field. */
const BASES: Record<string, Doc[]> = {
  node: [
    {
      name: 'N',
      type: 'service',
      description: 'd',
      aspects: [{ id: 'r1', status: 'enforced', when: NODE_WHEN }, 'r2'],
      relations: [{ target: 'other', type: 'emits', portNames: ['p'], event_name: 'ev' }],
      mapping: ['src/a.ts'],
      ports: { p: { description: 'port', aspects: [{ id: 'r3', status: 'enforced', when: NODE_WHEN }] } },
      max_direct_relations: { limit: 5, reason: 'why' },
    },
    { name: 'N', type: 'service', description: 'd', relations: [{ target: 'other', type: 'calls', consumes: ['p'] }] },
  ],
  architecture: [
    {
      node_types: {
        service: {
          description: 'd',
          aspects: [{ id: 'r1', status: 'enforced', when: NODE_WHEN }],
          parents: ['module'],
          relations: { calls: ['x'], uses: [], extends: [], implements: [], emits: [], listens: [], default: 'deny' },
          log_required: true,
          when: FILE_WHEN,
          enforce: 'strict',
        },
      },
    },
  ],
  aspect: [ASPECT_DOC],
  'aspect-adapt': [
    {
      status: 'advisory',
      review_by: '2027-01-31',
      scope: { per: 'file', files: FILE_WHEN },
      reviewer: { type: 'llm', tier: 'deep' },
      references: [{ path: 'ref.md', description: 'r' }],
      companion: 'comp.mjs',
      config: {},
    },
  ],
  flow: [
    { name: 'F', description: 'd', nodes: ['a'], aspects: [{ id: 'r', status: 'enforced', when: NODE_WHEN }] },
    { name: 'F', description: 'd', participants: ['a'] },
  ],
  config: [CONFIG_DOC],
  secrets: [CONFIG_DOC],
  package: [
    {
      schema: 'yg-package/1',
      name: 'p',
      version: '1.0.0',
      requires: { yg: '6.x' },
      aspects: ['naming'],
      config: { naming: { threshold: { type: 'number', default: 40 } } },
    },
  ],
  marketplace: [{ schema: 'yg-marketplace/1', packages: [{ name: 'p', path: 'packages/p', version: '1.0.0' }] }],
  packages: [
    {
      schema: 'yg-packages/1',
      packages: {
        p: {
          source: 'https://example.com/r',
          package: 'o/r/p',
          version: '1.0.0',
          requested: 'latest',
          tag: 'pack/p@1.0.0',
          commit: 'a'.repeat(40),
          identity: 'given',
          installed_at: '2026-09-01T12:00:00.000Z',
          files: { 'packages/o/r/p/naming/content.md': 'b'.repeat(64) },
        },
      },
    },
  ],
};

/**
 * Mutations the parser deliberately does not refuse, each with the reason.
 * Keyed `<format> <path>`; a field's own `tolerated` note covers its type.
 */
const NOT_REFUSED: Record<string, string> = {
  'secrets progressive': 'the overlay\'s progressive: is never read — the committed file alone decides it',
  'secrets progressive.reference': 'as above',
  'secrets rules_artifacts': 'the overlay\'s rules_artifacts: is never read — the committed file alone decides it',
  'secrets rules_artifacts.agents_md': 'as above',
  'secrets rules_artifacts.claude_md': 'as above',
  'secrets rules_artifacts.clinerules': 'as above',
  'secrets progressive <unknown key>': 'as above',
  'secrets rules_artifacts <unknown key>': 'as above',
};

let root: string;
let counter = 0;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'yg-format-conformance-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Parse `doc` as `format` with the real parser; true when it is accepted. */
async function accepted(format: string, doc: Doc): Promise<{ ok: boolean; why: string }> {
  const dir = path.join(root, `case-${counter++}`);
  await mkdir(dir, { recursive: true });
  const write = (name: string, value: unknown) => writeFile(path.join(dir, name), typeof value === 'string' ? value : stringify(value));
  try {
    switch (format) {
      case 'node':
        await write('yg-node.yaml', doc);
        await parseNodeYaml(path.join(dir, 'yg-node.yaml'));
        return { ok: true, why: '' };
      case 'architecture':
        await write('yg-architecture.yaml', doc);
        await parseArchitecture(path.join(dir, 'yg-architecture.yaml'));
        return { ok: true, why: '' };
      case 'flow':
        await write('yg-flow.yaml', doc);
        await parseFlow(dir, path.join(dir, 'yg-flow.yaml'));
        return { ok: true, why: '' };
      case 'aspect':
      case 'aspect-adapt': {
        const aspectDir = path.join(dir, '.yggdrasil', 'aspects', 'rule');
        await mkdir(aspectDir, { recursive: true });
        await writeFile(path.join(aspectDir, 'content.md'), '# rule\n');
        await writeFile(path.join(dir, 'ref.md'), 'ref\n');
        await writeFile(path.join(dir, 'comp.mjs'), 'export default () => [];\n');
        if (format === 'aspect') {
          await writeFile(path.join(aspectDir, 'yg-aspect.yaml'), stringify(doc));
        } else {
          await writeFile(path.join(aspectDir, 'yg-aspect.yaml'), stringify({ name: 'A', description: 'd', reviewer: { type: 'llm' } }));
          await writeFile(path.join(aspectDir, 'yg-aspect.adapt.yaml'), stringify(doc));
        }
        const r = await parseAspect(aspectDir, path.join(aspectDir, 'yg-aspect.yaml'), 'rule', { projectRoot: dir });
        return r.ok ? { ok: true, why: '' } : { ok: false, why: r.errors.map((e) => `${e.code}: ${e.messageData.what}`).join('; ') };
      }
      case 'config':
      case 'secrets': {
        if (format === 'config') await write('yg-config.yaml', doc);
        else {
          await write('yg-config.yaml', { version: '6.1.0' });
          await write('yg-secrets.yaml', doc);
        }
        const r = await parseConfigDetailed(path.join(dir, 'yg-config.yaml'));
        return r.unknownKeys.length === 0 ? { ok: true, why: '' } : { ok: false, why: `unknown ${r.unknownKeys.map((u) => u.key).join(', ')}` };
      }
      case 'package': {
        await write('yg-package.yaml', doc);
        const r = await parsePackageManifest(path.join(dir, 'yg-package.yaml'));
        return r.ok ? { ok: true, why: '' } : { ok: false, why: r.errors[0].messageData.what };
      }
      case 'marketplace': {
        await write('yg-marketplace.yaml', doc);
        const r = await parseMarketplaceManifest(path.join(dir, 'yg-marketplace.yaml'));
        return r.ok ? { ok: true, why: '' } : { ok: false, why: r.errors[0].messageData.what };
      }
      case 'packages': {
        await write('yg-packages.yaml', doc);
        const r = await parsePackagesLock(path.join(dir, 'yg-packages.yaml'));
        return r.ok ? { ok: true, why: '' } : { ok: false, why: r.errors[0].messageData.what };
      }
      default:
        throw new Error(`no parser wired for format '${format}'`);
    }
  } catch (err) {
    return { ok: false, why: (err as Error).message };
  }
}

/** A path's steps: `relations[].target` → relations, 0, target; `<x>` → the first key there. */
function steps(p: string): Array<string | number | null> {
  const out: Array<string | number | null> = [];
  for (const part of p.split('.')) {
    const m = /^(.*?)((?:\[\])*)$/.exec(part)!;
    out.push(/^<.*>$/.test(m[1]) ? null : m[1]);
    for (let i = 0; i < m[2].length / 2; i++) out.push(0);
  }
  return out;
}

/** The container holding the value at `p` in `doc`, and its key; undefined when `doc` lacks the path. */
function locate(doc: unknown, p: string): { container: Record<string | number, unknown>; key: string | number } | undefined {
  const s = steps(p);
  let cur: unknown = doc;
  for (let i = 0; i < s.length; i++) {
    if (cur === null || typeof cur !== 'object') return undefined;
    const key = s[i] === null ? Object.keys(cur as object)[0] : s[i]!;
    if (key === undefined || !Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    if (i === s.length - 1) return { container: cur as Record<string | number, unknown>, key };
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return undefined;
}

/** A value of the wrong type for `type`, or undefined when no value is wrong (a predicate). */
function wrongValue(type: FieldType): unknown {
  switch (type.kind) {
    case 'string':
      return type.values !== undefined ? 'zz-not-a-value' : 12345;
    case 'boolean':
      return 'yes';
    case 'integer':
    case 'number':
      return 'many';
    case 'list':
    case 'map':
    case 'object':
      return 'scalar';
    case 'oneOf':
      return 12345;
    case 'scalar':
      return ['a', 'list'];
    case 'predicate':
      return undefined;
  }
}

/** Every closed mapping of a format, with its path (`''` for the top level). */
function closedObjects(schema: FileFormatSchema): Array<{ path: string; type: ObjectType }> {
  const out: Array<{ path: string; type: ObjectType }> = [];
  const walk = (type: FieldType, p: string): void => {
    if (type.kind === 'object') {
      if (type.open === undefined) out.push({ path: p, type });
      for (const [k, f] of Object.entries(type.fields)) walk(f.type, p === '' ? k : `${p}.${k}`);
    } else if (type.kind === 'list') walk(type.of, `${p}[]`);
    else if (type.kind === 'map') walk(type.of, `${p}.<${type.key}>`);
    else if (type.kind === 'oneOf') for (const t of type.of) walk(t, p);
  };
  walk(schema.root, '');
  return out;
}

function baseWith(format: string, p: string): Doc | undefined {
  return BASES[format].find((d) => p === '' || locate(d, p) !== undefined);
}

describe('every file format\'s parser enforces its schema', () => {
  for (const format of FILE_FORMATS) {
    describe(format.name, () => {
      it('accepts each full valid document', async () => {
        expect(BASES[format.name], `no base document for ${format.name}`).toBeDefined();
        for (const doc of BASES[format.name]) {
          const r = await accepted(format.name, doc);
          expect(r.ok, `${format.name}: the valid base document was refused: ${r.why}`).toBe(true);
        }
      });

      it('has every declared key in some valid document', () => {
        const missing = fieldRows(format).map((r) => r.path).filter((p) => baseWith(format.name, p) === undefined);
        expect(missing, `${format.name}: declared keys no base document carries`).toEqual([]);
      });

      it('refuses a value of the wrong type for every declared key', async () => {
        const accepted_: string[] = [];
        const stale: string[] = [];
        for (const { path: p, field } of fieldRows(format)) {
          const wrong = wrongValue(field.type);
          if (wrong === undefined) continue;
          const doc = structuredClone(baseWith(format.name, p)!);
          const at = locate(doc, p)!;
          at.container[at.key] = wrong;
          const r = await accepted(format.name, doc);
          const exempt = field.tolerated !== undefined || NOT_REFUSED[`${format.name} ${p}`] !== undefined;
          if (r.ok && !exempt) accepted_.push(`${p} = ${JSON.stringify(wrong)}`);
          if (!r.ok && exempt) stale.push(`${p} (refused: ${r.why})`);
        }
        expect(accepted_, `${format.name}: the parser accepted a value the schema says is the wrong type`).toEqual([]);
        expect(stale, `${format.name}: a key marked tolerated or exempt is refused after all — drop the exemption`).toEqual([]);
      });

      it('refuses an unknown key in every closed mapping', async () => {
        const accepted_: string[] = [];
        const stale: string[] = [];
        for (const { path: p } of closedObjects(format)) {
          const doc = structuredClone(baseWith(format.name, p)!);
          const target = p === '' ? doc : (locate(doc, p)!.container[locate(doc, p)!.key] as Doc);
          target.zzq_unknown_key = 1;
          const r = await accepted(format.name, doc);
          const exempt = NOT_REFUSED[`${format.name} ${p} <unknown key>`] !== undefined;
          if (r.ok && !exempt) accepted_.push(p === '' ? '<top level>' : p);
          if (!r.ok && exempt) stale.push(p);
        }
        expect(accepted_, `${format.name}: the parser accepted a key the schema does not declare`).toEqual([]);
        expect(stale, `${format.name}: a mapping marked exempt refuses unknown keys after all — drop the exemption`).toEqual([]);
      });
    });
  }
});
