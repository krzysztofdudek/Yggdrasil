// =============================================================================
// JSON Schema for the machine documents — derived, never hand-written.
//
// Two sources, one output shape (draft 2020-12, every mapping closed with
// `additionalProperties: false` unless it is a keyed map):
//
//  - schemaFromType: a yg-*/1 JSON document's TypeScript interface, read with
//    the TypeScript compiler's type checker — so the schema is the type the
//    emitter is compiled against, not a second description of it.
//  - schemaFromFileFormat: a versioned YAML document (yg-package/1, …) from its
//    file-format schema object (utils/file-formats*.ts), the one its parser
//    enforces.
//
// The validator for them is json-schema-validate.ts.
// =============================================================================

import ts from 'typescript';
import type { FieldType, FileFormatSchema } from '../../../src/utils/file-schema.js';

export type JsonSchema = Record<string, unknown>;

/**
 * Carried by every closed schema: what it is for, and what it must not be used
 * for, since a closed schema used on read would break the family's /1 promise.
 */
export const CLOSED_SCHEMA_COMMENT =
  'This schema describes exactly what this release of Yggdrasil writes: every mapping is closed and every enumeration lists only the values this release uses. Use it to check a producer. Do not use it to reject a document you read: under the family rule a later release may add a field or a value within /1, and a /1 reader ignores what it does not know (see family-contracts).';

/** A TypeScript program over the CLI's sources, for reading document types out of. */
export function documentProgram(files: string[]): { program: ts.Program; checker: ts.TypeChecker } {
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: ['node'],
  });
  return { program, checker: program.getTypeChecker() };
}

/** The schema of the exported interface or type alias `typeName` in `file`. */
export function schemaFromType(
  env: { program: ts.Program; checker: ts.TypeChecker },
  file: string,
  typeName: string,
  meta: { id: string; title: string },
): JsonSchema {
  const { program, checker } = env;
  const source = program.getSourceFile(file);
  if (source === undefined) throw new Error(`not in the program: ${file}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  const exported = moduleSymbol === undefined ? undefined : checker.getExportsOfModule(moduleSymbol).find((s) => s.name === typeName);
  if (exported === undefined) throw new Error(`${file} exports no '${typeName}'`);
  const root = checker.getDeclaredTypeOfSymbol(exported);

  const defs: Record<string, JsonSchema> = {};
  const named = new Map<ts.Type, string>();
  const described = (schema: JsonSchema, symbol: ts.Symbol | undefined): JsonSchema => {
    const doc = symbol === undefined ? '' : ts.displayPartsToString(symbol.getDocumentationComment(checker)).replace(/\s+/g, ' ').trim();
    return doc === '' ? schema : { description: doc, ...schema };
  };

  const isOptionalUndefined = (t: ts.Type): boolean => (t.flags & ts.TypeFlags.Undefined) !== 0 || (t.flags & ts.TypeFlags.Void) !== 0;

  const convert = (type: ts.Type, top = false): JsonSchema => {
    if (type.isUnion()) return convertUnion(type);
    const f = type.flags;
    if (f & ts.TypeFlags.StringLiteral) return { const: (type as ts.StringLiteralType).value };
    if (f & ts.TypeFlags.NumberLiteral) return { const: (type as ts.NumberLiteralType).value };
    if (f & ts.TypeFlags.BooleanLiteral) return { const: (type as unknown as { intrinsicName: string }).intrinsicName === 'true' };
    if (f & ts.TypeFlags.String || f & ts.TypeFlags.TemplateLiteral) return { type: 'string' };
    if (f & ts.TypeFlags.Number) return { type: 'number' };
    if (f & ts.TypeFlags.Boolean) return { type: 'boolean' };
    if (f & ts.TypeFlags.Null) return { type: 'null' };
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      const args = checker.getTypeArguments(type as ts.TypeReference);
      if (checker.isTupleType(type)) return { type: 'array', prefixItems: args.map((a) => convert(a)), items: false };
      return { type: 'array', items: convert(args[0]) };
    }
    if (f & ts.TypeFlags.Object || type.isIntersection()) {
      const name = nameOf(type);
      if (name !== undefined && !top) {
        if (!named.has(type)) {
          let key = name;
          for (let i = 2; key in defs; i++) key = `${name}${i}`;
          named.set(type, key);
          defs[key] = {};
          defs[key] = convertObject(type);
        }
        return { $ref: `#/$defs/${named.get(type)}` };
      }
      return convertObject(type);
    }
    throw new Error(`${typeName}: no JSON Schema for type '${checker.typeToString(type)}'`);
  };

  const nameOf = (type: ts.Type): string | undefined => {
    const sym = type.aliasSymbol ?? type.getSymbol();
    if (sym === undefined) return undefined;
    if (sym.name === '__type' || sym.name === '__object' || sym.name === 'Record' || sym.name === 'Array') return undefined;
    const decl = sym.declarations?.[0];
    if (decl === undefined || !(ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl))) return undefined;
    return sym.name;
  };

  const convertUnion = (type: ts.UnionType): JsonSchema => {
    let members = type.types.filter((t) => !isOptionalUndefined(t));
    const hasTrue = members.some((t) => t.flags & ts.TypeFlags.BooleanLiteral && (t as unknown as { intrinsicName: string }).intrinsicName === 'true');
    const hasFalse = members.some((t) => t.flags & ts.TypeFlags.BooleanLiteral && (t as unknown as { intrinsicName: string }).intrinsicName === 'false');
    const out: JsonSchema[] = [];
    if (hasTrue && hasFalse) {
      members = members.filter((t) => !(t.flags & ts.TypeFlags.BooleanLiteral));
      out.push({ type: 'boolean' });
    }
    const strings = members.filter((t) => t.flags & ts.TypeFlags.StringLiteral).map((t) => (t as ts.StringLiteralType).value);
    const numbers = members.filter((t) => t.flags & ts.TypeFlags.NumberLiteral).map((t) => (t as ts.NumberLiteralType).value);
    const rest = members.filter((t) => !(t.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral)));
    if (strings.length > 0) out.push(strings.length === 1 ? { const: strings[0] } : { enum: strings.sort() });
    if (numbers.length > 0) out.push(numbers.length === 1 ? { const: numbers[0] } : { enum: numbers.sort((a, b) => a - b) });
    for (const t of rest) out.push(convert(t));
    if (out.length === 1) return out[0];
    // `T | null` for a plain type reads better as a type list.
    const simple = out.every((s) => Object.keys(s).length === 1 && typeof s.type === 'string');
    if (simple) return { type: out.map((s) => s.type as string) };
    return { anyOf: out };
  };

  const convertObject = (type: ts.Type): JsonSchema => {
    const props = checker.getPropertiesOfType(type);
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const p of props) {
      const decl = p.valueDeclaration ?? p.declarations?.[0];
      const pt = decl !== undefined ? checker.getTypeOfSymbolAtLocation(p, decl) : checker.getTypeOfSymbol(p);
      const optional = (p.flags & ts.SymbolFlags.Optional) !== 0 || (pt.isUnion() && pt.types.some(isOptionalUndefined));
      properties[p.name] = described(convert(pt), p);
      if (!optional) required.push(p.name);
    }
    const index = checker.getIndexInfosOfType(type).find((i) => i.keyType.flags & ts.TypeFlags.String);
    const schema: JsonSchema = { type: 'object' };
    if (props.length > 0) schema.properties = properties;
    if (required.length > 0) schema.required = required;
    schema.additionalProperties = index !== undefined ? convert(index.type) : false;
    return schema;
  };

  // A document with more than one form (the full run report and its compact
  // form) is the union of its forms.
  const body = root.isUnion() ? convertUnion(root) : convertObject(root);
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://krzysztofdudek.github.io/Yggdrasil/schemas/${meta.id.replace('/', '-')}.schema.json`,
    title: meta.title,
    $comment: CLOSED_SCHEMA_COMMENT,
    ...body,
    ...(Object.keys(defs).length > 0 && { $defs: Object.fromEntries(Object.entries(defs).sort(([a], [b]) => a.localeCompare(b))) }),
  };
}

/** The schema of a versioned YAML document, from the file-format schema its parser enforces. */
export function schemaFromFileFormat(format: FileFormatSchema, meta: { id: string; title: string }): JsonSchema {
  const convert = (type: FieldType): JsonSchema => {
    switch (type.kind) {
      case 'string':
        return type.values !== undefined ? (type.values.length === 1 ? { const: type.values[0] } : { enum: [...type.values] }) : { type: 'string', ...(type.nonEmpty && { minLength: 1 }) };
      case 'boolean':
        return { type: 'boolean' };
      case 'integer':
        return { type: 'integer', ...(type.min !== undefined && { minimum: type.min }) };
      case 'number':
        return { type: 'number', ...(type.min !== undefined && { minimum: type.min }) };
      case 'list':
        return { type: 'array', items: convert(type.of) };
      case 'map':
        return { type: 'object', additionalProperties: convert(type.of) };
      case 'object': {
        const properties: Record<string, JsonSchema> = {};
        const required: string[] = [];
        for (const [k, f] of Object.entries(type.fields)) {
          properties[k] = { description: f.description, ...convert(f.type) };
          if (f.required !== undefined) required.push(k);
        }
        return { type: 'object', properties, ...(required.length > 0 && { required }), additionalProperties: type.open !== undefined };
      }
      case 'oneOf':
        return { anyOf: type.of.map(convert) };
      case 'predicate':
        return {};
      case 'scalar':
        return { type: ['string', 'number', 'boolean'] };
    }
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://krzysztofdudek.github.io/Yggdrasil/schemas/${meta.id.replace('/', '-')}.schema.json`,
    title: meta.title,
    description: `${format.summary} Read from ${format.file}. A key not listed is ignored by this reader (the /1 rule), so additionalProperties is true.`,
    ...convert(format.root),
  };
}

/** Every property name a schema declares, anywhere in it. */
export function propertyNames(schema: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) for (const s of schema) propertyNames(s, out);
  else if (schema !== null && typeof schema === 'object') {
    const obj = schema as Record<string, unknown>;
    if (obj.properties !== null && typeof obj.properties === 'object') for (const k of Object.keys(obj.properties)) out.add(k);
    for (const [k, v] of Object.entries(obj)) if (k !== 'const' && k !== 'enum') propertyNames(v, out);
  }
  return out;
}

/** Every yg-*\/1 JSON document, with the interface it is built against (paths relative to source/cli). */
export const JSON_DOCUMENTS: ReadonlyArray<{ id: string; title: string; file: string; type: string }> = [
  { id: 'yg-check/1', title: 'Run report (yg check --json, and its --compact form)', file: 'src/formatters/check-json.ts', type: 'CheckJsonAnyDocument' },
  { id: 'yg-context/1', title: 'Context package (yg context --json)', file: 'src/formatters/context-json.ts', type: 'ContextJsonDocument' },
  { id: 'yg-impact/1', title: 'Blast radius (yg impact --json)', file: 'src/formatters/impact-json.ts', type: 'ImpactJsonDocument' },
  { id: 'yg-node/1', title: 'Component (yg node --json)', file: 'src/formatters/node-json.ts', type: 'NodeJsonDocument' },
  { id: 'yg-aspects/1', title: 'Rule list (yg aspects --json)', file: 'src/formatters/aspects-json.ts', type: 'AspectsJsonDocument' },
  { id: 'yg-aspects-health/1', title: 'Rule health (yg aspects --health --json)', file: 'src/formatters/aspects-health-json.ts', type: 'AspectsHealthJsonDocument' },
  { id: 'yg-advise/1', title: 'Attention feed (yg advise --json)', file: 'src/formatters/advise-json.ts', type: 'AdviseJsonDocument' },
  { id: 'yg-aspect-log/1', title: 'Rule history (yg aspects log read --json)', file: 'src/formatters/aspect-log-json.ts', type: 'AspectLogJsonDocument' },
  { id: 'yg-suppressions/1', title: 'Waiver inventory (yg suppressions --json)', file: 'src/formatters/suppressions-json.ts', type: 'SuppressionsJsonDocument' },
  { id: 'yg-drill/1', title: 'Drill run (yg drill --json)', file: 'src/formatters/drill-json.ts', type: 'DrillJsonDocument' },
  { id: 'yg-error/1', title: 'Command error (any command run with --json that fails)', file: 'src/cli/output.ts', type: 'ErrorDocument' },
  { id: 'yg-tree/1', title: 'Node list (yg tree --json)', file: 'src/cli/tree.ts', type: 'TreeJsonDocument' },
  { id: 'yg-owner/1', title: 'File owner (yg owner --json)', file: 'src/cli/owner.ts', type: 'OwnerJsonDocument' },
  { id: 'yg-find/1', title: 'Search results (yg find --json)', file: 'src/cli/find.ts', type: 'FindJsonDocument' },
  { id: 'yg-log/1', title: 'Component log (yg log read --node --json)', file: 'src/cli/log.ts', type: 'LogJsonDocument' },
  { id: 'yg-type-log/1', title: 'Type decisions (yg log read --type --json)', file: 'src/cli/log.ts', type: 'TypeLogJsonDocument' },
  { id: 'yg-package-versions/1', title: 'Package versions cache (.yggdrasil/.yg-packages-versions.json)', file: 'src/io/package-versions-cache.ts', type: 'PackageVersionsCache' },
];

/** The versioned YAML documents, with the file format their parser enforces. */
export const YAML_DOCUMENTS: ReadonlyArray<{ id: string; title: string; format: string }> = [
  { id: 'yg-package/1', title: 'Package manifest (yg-package.yaml)', format: 'package' },
  { id: 'yg-marketplace/1', title: 'Marketplace manifest (yg-marketplace.yaml)', format: 'marketplace' },
  { id: 'yg-packages/1', title: 'Package record (.yggdrasil/yg-packages.yaml)', format: 'packages' },
];
