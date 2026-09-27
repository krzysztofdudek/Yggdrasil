// =============================================================================
// GUARD — every yg-*/1 document has a JSON Schema derived from its type, and
// every field of it is named in the reference.
//
// The JSON documents Yggdrasil writes (`yg check --json`, `yg context --json`,
// …) are each built against one exported TypeScript interface. This test reads
// those interfaces with the TypeScript compiler (json-schema-from-types.ts, beside this test)
// and derives a JSON Schema from each — every mapping closed with
// `additionalProperties: false` — and does the same for the three versioned
// YAML package documents from the file-format schemas their parsers enforce.
// The schemas are published with the docs (docs/public/schemas/, served at
// /schemas/<id>.schema.json); this test fails when a committed schema differs
// from what the types say, and with YG_JSON_SCHEMAS_UPDATE=1 (npm run
// json-schemas:update) rewrites them.
//
// It also requires every property name any schema declares to be named, in
// backticks, on docs/family-contracts.md or docs/cli-reference.md — a field a
// consumer can receive and nobody documented is the drift this exists to stop.
//
// tests/e2e/json-contract-documents.test.ts validates real emitted documents
// against these schemas.
// =============================================================================

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOSED_SCHEMA_COMMENT, JSON_DOCUMENTS, YAML_DOCUMENTS, documentProgram, propertyNames, schemaFromFileFormat, schemaFromType, type JsonSchema } from './json-schema-from-types.js';
import { schemaFileName, validate } from '../../support/json-schema-validate.js';
import { fileFormat } from '../../../src/utils/file-formats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(__dirname, '..', '..', '..');
const REPO_ROOT = path.resolve(CLI_ROOT, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'public', 'schemas');
const UPDATE = process.env.YG_JSON_SCHEMAS_UPDATE === '1';

let derived: Map<string, JsonSchema>;

beforeAll(() => {
  const env = documentProgram(JSON_DOCUMENTS.map((d) => path.join(CLI_ROOT, d.file)));
  derived = new Map();
  for (const d of JSON_DOCUMENTS) derived.set(d.id, schemaFromType(env, path.join(CLI_ROOT, d.file), d.type, d));
  for (const d of YAML_DOCUMENTS) derived.set(d.id, schemaFromFileFormat(fileFormat(d.format)!, d));
}, 120000);

describe('the yg-*/1 JSON Schemas are derived from the document types', () => {
  it('each document type names its own schema id, in every form it takes', () => {
    for (const d of JSON_DOCUMENTS) {
      const schema = derived.get(d.id)!;
      const defs = (schema.$defs ?? {}) as Record<string, JsonSchema>;
      const resolve = (s: JsonSchema): JsonSchema => (typeof s.$ref === 'string' ? defs[s.$ref.replace('#/$defs/', '')] : s);
      const forms = Array.isArray(schema.anyOf) ? (schema.anyOf as JsonSchema[]).map(resolve) : [schema];
      for (const form of forms) {
        const idField = (form.properties as Record<string, JsonSchema> | undefined)?.schema;
        expect(idField, `${d.id}: a form of the type has no schema field`).toBeDefined();
        expect(idField!.const, `${d.type} does not declare schema: '${d.id}'`).toBe(d.id);
      }
    }
  });

  it('every closed schema says it checks producers and must not reject documents on read', () => {
    for (const d of JSON_DOCUMENTS) expect(derived.get(d.id)!.$comment, d.id).toBe(CLOSED_SCHEMA_COMMENT);
  });

  it('the published schemas are the derived ones', () => {
    if (UPDATE) mkdirSync(OUT_DIR, { recursive: true });
    const stale: string[] = [];
    for (const [id, schema] of derived) {
      const file = path.join(OUT_DIR, schemaFileName(id));
      const text = `${JSON.stringify(schema, null, 2)}\n`;
      if (UPDATE) writeFileSync(file, text);
      let current: string;
      try {
        current = readFileSync(file, 'utf-8');
      } catch {
        current = '';
      }
      if (current !== text) stale.push(schemaFileName(id));
    }
    expect(stale, 'a published JSON Schema differs from its type — run npm run json-schemas:update in source/cli').toEqual([]);
  });

  it('publishes no schema for a document that does not exist', () => {
    const expected = new Set([...derived.keys()].map(schemaFileName));
    const extra = readdirSync(OUT_DIR).filter((f) => f.endsWith('.schema.json') && !expected.has(f));
    expect(extra).toEqual([]);
  });

  it('the validator the fixture matrix uses refuses what the schemas forbid', () => {
    const find = derived.get('yg-find/1')!;
    const result = { kind: 'node', id: 'a', type: 'service', status: null, description: 'd', score: 1, matched: ['a'], next: 'yg context --node a' };
    expect(validate({ schema: 'yg-find/1', query: 'a', results: [result] }, find)).toEqual([]);
    expect(validate({ schema: 'yg-find/1', query: 'a', results: [], extra: 1 }, find)).toEqual(["$: 'extra' is not in the schema"]);
    expect(validate({ schema: 'yg-find/1', query: 'a', results: [{ ...result, stray: true }] }, find)).toEqual(["$.results[0]: 'stray' is not in the schema"]);
    expect(validate({ schema: 'yg-find/1', results: [] }, find)).toEqual(["$: missing required 'query'"]);
    expect(validate({ schema: 'yg-find/2', query: 'a', results: [] }, find)).toHaveLength(1);
    expect(validate({ schema: 'yg-find/1', query: 'a', results: [{ ...result, kind: 'port' }] }, find)).toHaveLength(1);
  });

  it('every field of every schema is named in family-contracts or cli-reference', () => {
    const named = new Set<string>();
    for (const page of ['family-contracts.md', 'cli-reference.md']) {
      const text = readFileSync(path.join(REPO_ROOT, 'docs', page), 'utf-8');
      for (const m of text.matchAll(/`([^`\n]+)`/g)) {
        for (const token of m[1].split(/[^A-Za-z0-9_-]+/)) if (token !== '') named.add(token);
        for (const token of m[1].split(/[^A-Za-z0-9_]+/)) if (token !== '') named.add(token);
      }
    }
    const missing: string[] = [];
    for (const [id, schema] of derived) {
      for (const field of propertyNames(schema)) if (!named.has(field)) missing.push(`${id}: ${field}`);
    }
    expect(missing, 'a document field no reference page names — describe it in docs/cli-reference.md (or family-contracts.md)').toEqual([]);
  });
});
