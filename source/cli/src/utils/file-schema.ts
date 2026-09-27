/**
 * source/cli/src/utils/file-schema.ts — the shape of a file-format schema, and
 * the three things done with one: find where a parsed YAML value departs from
 * it, name the keys a block accepts, and render its field table.
 *
 * Each YAML file the CLI reads (yg-config.yaml, yg-node.yaml, a flow, a package
 * manifest, …) is described once, as a tree of {@link FieldType}s, in the
 * file-formats modules beside this one. That one description is what the
 * parser takes its accepted keys and retired keys from, what it checks every
 * value's type against after its own checks have run, what `yg schemas read`
 * prints as the field table, and what the docs field tables are generated from
 * — so the four can no longer describe four different files.
 *
 * The parsers keep their own, more specific checks and messages (a missing
 * name, a relation type that does not exist, a path that leaves the
 * repository); {@link schemaProblems} is the uniform floor under them, and it
 * only ever finds what those checks let through.
 *
 * Pure: no IO. Shared by the parsers (io/), the `yg schemas` command and the
 * tests that render the docs tables.
 */

import { describeUnknownKeys, findUnknownKeys, type RetiredKeys } from './known-keys.js';

/** One field of a mapping: its type, whether it must be there, and what it means. */
export interface Field {
  type: FieldType;
  /**
   * `true` when the parser refuses the file without it; a string when the
   * answer needs words ("yes, except on a port named default"). Absent means
   * optional. Documentation only: presence is enforced by each parser's own
   * checks, which name the missing field in words the reader can act on.
   */
  required?: true | string;
  /** One line: what the field is for. Rendered in `yg schemas read` and in the docs. */
  description: string;
  /** The value used when the field is absent, as written in YAML. */
  default?: string;
  /**
   * Set when the parser deliberately accepts a value of the wrong type here and
   * falls back to something safe, with the reason. {@link schemaProblems} then
   * does not check the value's type (unknown keys inside it are still refused).
   */
  tolerated?: string;
}

/** The type of one value in a file. */
export type FieldType =
  | { kind: 'string'; values?: readonly string[]; nonEmpty?: boolean; format?: string }
  | { kind: 'boolean' }
  | { kind: 'integer'; min?: number }
  | { kind: 'number'; min?: number }
  | { kind: 'list'; of: FieldType }
  | { kind: 'map'; key: string; of: FieldType }
  | ObjectType
  | { kind: 'oneOf'; of: readonly FieldType[] }
  | { kind: 'predicate'; grammar: 'node' | 'file' }
  | { kind: 'scalar' };

/**
 * A mapping with named keys. `closed` (the default) refuses any key it does not
 * declare; an open object reads the keys it declares and ignores the rest — used
 * only for the versioned package documents, whose schema id carries the promise
 * that a field added within `/1` is ignored by a reader that does not know it.
 */
export interface ObjectType {
  kind: 'object';
  fields: Readonly<Record<string, Field>>;
  /** Keys an earlier release read, and what became of each. */
  retired?: RetiredKeys;
  /** Keys refused here although they mean something elsewhere, each with the reason. */
  refused?: RetiredKeys;
  /** Set (to the reason) when keys this type does not declare are ignored rather than refused. */
  open?: string;
}

/** One file format: the file, what it is, and the shape of its top level. */
export interface FileFormatSchema {
  /** The name `yg schemas read <name>` takes. */
  name: string;
  /** Where the file lives, as a reader would write it. */
  file: string;
  /** One line for `yg schemas list`. */
  summary: string;
  root: ObjectType;
}

/** The keys an object type accepts, in declaration order. */
export function keysOf(type: ObjectType): readonly string[] {
  return Object.keys(type.fields);
}

/** The retired keys of an object type (none when it declares none). */
export function retiredOf(type: ObjectType): RetiredKeys {
  return type.retired ?? {};
}

/** The keys an object type refuses with a reason of their own (none when it declares none). */
export function refusedOf(type: ObjectType): RetiredKeys {
  return type.refused ?? {};
}

/** One place a value departs from its schema. */
export interface SchemaProblem {
  /** Where, as `relations[0].event_name`; empty for the top level. */
  where: string;
  kind: 'unknown-key' | 'type';
  /** One sentence, ready to follow `<file>: `. */
  message: string;
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function join(where: string, key: string): string {
  return where === '' ? key : `${where}.${key}`;
}

function shown(value: unknown): string {
  if (Array.isArray(value)) return 'a list';
  if (isMapping(value)) return 'a mapping';
  return JSON.stringify(value);
}

/** What a value of this type is, in words: "a string", "one of: node, file". */
function typeWords(type: FieldType): string {
  switch (type.kind) {
    case 'string':
      if (type.values !== undefined) return `one of: ${type.values.join(', ')}`;
      return type.nonEmpty ? 'a non-empty string' : 'a string';
    case 'boolean':
      return 'true or false';
    case 'integer':
      return type.min !== undefined ? `an integer >= ${type.min}` : 'an integer';
    case 'number':
      return type.min !== undefined ? `a number >= ${type.min}` : 'a number';
    case 'list':
      return 'a list';
    case 'map':
    case 'object':
      return 'a mapping';
    case 'oneOf':
      return type.of.map(typeWords).join(', or ');
    case 'predicate':
      return `a ${type.grammar} predicate`;
    case 'scalar':
      return 'a string, number or boolean';
  }
}

/** True when `value` has the outer shape of `type` (its members are not looked at). */
function hasShape(value: unknown, type: FieldType): boolean {
  switch (type.kind) {
    case 'string':
      if (typeof value !== 'string') return false;
      if (type.values !== undefined) return type.values.includes(value);
      return !type.nonEmpty || value.trim() !== '';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value) && (type.min === undefined || value >= type.min);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && (type.min === undefined || value >= type.min);
    case 'list':
      return Array.isArray(value);
    case 'map':
    case 'object':
      return isMapping(value);
    case 'oneOf':
      return type.of.some((t) => hasShape(value, t));
    case 'predicate':
      return true;
    case 'scalar':
      return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
  }
}

/**
 * Every place `value` departs from `type`: a key a closed mapping does not
 * declare, or a value of the wrong type. A null value is read as absent — YAML
 * writes an empty `key:` as null, and each parser already decides for itself
 * whether a field may be empty. Presence is not checked here (see
 * {@link Field.required}); predicates are checked by their own grammar parser.
 */
export function schemaProblems(value: unknown, type: FieldType, where = ''): SchemaProblem[] {
  if (value === null || value === undefined) return [];
  if (!hasShape(value, type)) {
    return [{ where, kind: 'type', message: `${where === '' ? 'the file' : `'${where}'`} must be ${typeWords(type)} (got ${shown(value)}).` }];
  }
  switch (type.kind) {
    case 'list': {
      const out: SchemaProblem[] = [];
      (value as unknown[]).forEach((item, i) => out.push(...schemaProblems(item, type.of, `${where}[${i}]`)));
      return out;
    }
    case 'map': {
      const out: SchemaProblem[] = [];
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out.push(...schemaProblems(v, type.of, join(where, k)));
      return out;
    }
    case 'object':
      return objectProblems(value as Record<string, unknown>, type, where);
    case 'oneOf': {
      // The first alternative whose outer shape fits is the one the value meant.
      const chosen = type.of.find((t) => hasShape(value, t));
      return chosen === undefined ? [] : schemaProblems(value, chosen, where);
    }
    default:
      return [];
  }
}

/** `type` with every open mapping in it closed, so a key it does not declare is reported. */
function closedType(type: FieldType): FieldType {
  switch (type.kind) {
    case 'list':
      return { ...type, of: closedType(type.of) };
    case 'map':
      return { ...type, of: closedType(type.of) };
    case 'oneOf':
      return { ...type, of: type.of.map(closedType) };
    case 'object':
      return {
        kind: 'object',
        fields: Object.fromEntries(Object.entries(type.fields).map(([k, f]) => [k, { ...f, type: closedType(f.type) }])),
        ...(type.retired !== undefined && { retired: type.retired }),
        ...(type.refused !== undefined && { refused: type.refused }),
      };
    default:
      return type;
  }
}

/**
 * The keys an open mapping in `value` does not declare — the ones a reader of a
 * versioned document ignores by design (a field a later release added). Not a
 * refusal anywhere: it is what lets the author of such a document learn that a
 * key they wrote (a misspelling, most often) will be read by nobody.
 */
export function ignoredKeyProblems(value: unknown, type: FieldType): SchemaProblem[] {
  return schemaProblems(value, closedType(type)).filter((p) => p.kind === 'unknown-key');
}

function objectProblems(obj: Record<string, unknown>, type: ObjectType, where: string): SchemaProblem[] {
  const out: SchemaProblem[] = [];
  if (type.open === undefined) {
    const known = keysOf(type);
    const unknown = findUnknownKeys(obj, known, { ...retiredOf(type), ...refusedOf(type) });
    if (unknown.length > 0) out.push({ where, kind: 'unknown-key', message: describeUnknownKeys(where, unknown, known) });
  }
  for (const [key, field] of Object.entries(type.fields)) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const at = join(where, key);
    if (field.tolerated !== undefined) {
      // The value's type is the parser's to forgive; a typo inside it is not.
      if (field.type.kind === 'object' && isMapping(obj[key])) out.push(...objectProblems(obj[key] as Record<string, unknown>, { ...field.type }, at).filter((p) => p.kind === 'unknown-key'));
      continue;
    }
    out.push(...schemaProblems(obj[key], field.type, at));
  }
  return out;
}

// ============================================================
// Rendering — the field table of `yg schemas read` and the docs
// ============================================================

/** One row of a field table: a dotted path and its field. */
export interface FieldRow {
  path: string;
  field: Field;
}

/**
 * Every field of a format, depth first, as `relations[].target`,
 * `node_types.<type>.parents`, `ports.<port>.aspects[]`. A oneOf that allows a
 * mapping lists that mapping's fields under the same path.
 */
export function fieldRows(schema: FileFormatSchema): FieldRow[] {
  const rows: FieldRow[] = [];
  const walkType = (type: FieldType, path: string): void => {
    switch (type.kind) {
      case 'object':
        for (const [key, field] of Object.entries(type.fields)) {
          const p = path === '' ? key : `${path}.${key}`;
          rows.push({ path: p, field });
          walkType(field.type, p);
        }
        return;
      case 'list':
        walkType(type.of, `${path}[]`);
        return;
      case 'map':
        walkType(type.of, `${path}.<${type.key}>`);
        return;
      case 'oneOf':
        for (const t of type.of) walkType(t, path);
        return;
      default:
        return;
    }
  };
  walkType(schema.root, '');
  return rows;
}

/** The type column of a field table. */
function typeCell(type: FieldType): string {
  switch (type.kind) {
    case 'string':
      if (type.values !== undefined) return type.values.map((v) => `\`${v}\``).join(' \\| ');
      return type.format ?? 'string';
    case 'boolean':
      return 'boolean';
    case 'integer':
      return type.min !== undefined ? `integer ≥ ${type.min}` : 'integer';
    case 'number':
      return type.min !== undefined ? `number ≥ ${type.min}` : 'number';
    case 'list':
      return `list of ${typeCell(type.of)}`;
    case 'map':
      return `mapping of <${type.key}> to ${typeCell(type.of)}`;
    case 'object':
      return 'mapping';
    case 'oneOf':
      return type.of.map(typeCell).join(' or ');
    case 'predicate':
      return `${type.grammar} predicate`;
    case 'scalar':
      return 'string, number or boolean';
  }
}

/**
 * A table cell: one line, pipes escaped. With `html`, an angle bracket outside
 * a code span is escaped too — the docs site reads `<name>` in prose as an
 * HTML element.
 */
function cell(text: string, html: boolean): string {
  const piped = text.replace(/\n/g, ' ').replace(/(?<!\\)\|/g, '\\|');
  if (!html) return piped;
  return piped
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith('`') ? part : part.replace(/</g, '&lt;').replace(/>/g, '&gt;')))
    .join('');
}

/**
 * The field table of one format, as markdown: key, type, required, meaning.
 * `html` escapes angle brackets for the docs site. Retired keys and an open
 * top level are said after the table, since each changes how the file reads.
 */
export function renderFieldTable(schema: FileFormatSchema, opts: { html?: boolean } = {}): string {
  const html = opts.html === true;
  const lines = ['| Key | Type | Required | Meaning |', '|-----|------|----------|---------|'];
  for (const { path, field } of fieldRows(schema)) {
    const required = field.required === undefined ? 'no' : field.required === true ? 'yes' : field.required;
    const meaning = [field.description, field.default !== undefined ? `Default: \`${field.default}\`.` : '', field.tolerated !== undefined ? `A malformed value is ignored: ${field.tolerated}.` : '']
      .filter((s) => s !== '')
      .join(' ');
    lines.push(`| \`${path}\` | ${cell(typeCell(field.type), html)} | ${cell(required, html)} | ${cell(meaning, html)} |`);
  }
  const notes: string[] = [];
  const retired = collectRetired(schema);
  for (const [key, why] of Object.entries(refusedOf(schema.root))) notes.push(`\`${key}\` is refused: ${why}.`);
  if (retired.length > 0) {
    notes.push(`Retired keys, refused by name with what became of each (\`yg init --upgrade\` removes them): ${retired.map(([p, why]) => `\`${p}\` (${why})`).join('; ')}.`);
  }
  if (schema.root.open !== undefined) {
    notes.push(`A top-level key not listed here is ignored rather than refused: ${schema.root.open}.`);
  } else {
    notes.push('Any other key is refused by name, with the key it is probably a typo of.');
  }
  return [...lines, '', ...notes.map((n) => cell(n, html))].join('\n');
}

/** Every retired key of a format, with its dotted path and what became of it. */
function collectRetired(schema: FileFormatSchema): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (type: FieldType, path: string): void => {
    switch (type.kind) {
      case 'object':
        for (const [k, why] of Object.entries(type.retired ?? {})) out.push([path === '' ? k : `${path}.${k}`, why]);
        for (const [key, field] of Object.entries(type.fields)) walk(field.type, path === '' ? key : `${path}.${key}`);
        return;
      case 'list':
        walk(type.of, `${path}[]`);
        return;
      case 'map':
        walk(type.of, `${path}.<${type.key}>`);
        return;
      case 'oneOf':
        for (const t of type.of) walk(t, path);
        return;
      default:
        return;
    }
  };
  walk(schema.root, '');
  return out;
}
