// =============================================================================
// A small JSON Schema validator for exactly the keywords the published
// yg-*/1 schemas use (type, const, enum, properties, required,
// additionalProperties, items, prefixItems, anyOf, $ref into $defs) — enough to
// check an emitted document against its schema without a new dependency.
// Imports nothing from src/, so an e2e suite may use it.
// =============================================================================

export type JsonSchema = Record<string, unknown>;

/** The published file name of a document's schema: `yg-check/1` → `yg-check-1.schema.json`. */
export function schemaFileName(id: string): string {
  return `${id.replace('/', '-')}.schema.json`;
}

/** Where `value` departs from `schema`, as `<json path>: <problem>`; [] when it conforms. */
export function validate(value: unknown, schema: JsonSchema, rootSchema: JsonSchema = schema, where = '$'): string[] {
  if (typeof schema.$ref === 'string') {
    const target = (rootSchema.$defs as Record<string, JsonSchema> | undefined)?.[schema.$ref.replace('#/$defs/', '')];
    if (target === undefined) return [`${where}: unresolved ${schema.$ref}`];
    return validate(value, target, rootSchema, where);
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = (schema.anyOf as JsonSchema[]).map((s) => validate(value, s, rootSchema, where));
    if (branches.some((b) => b.length === 0)) return [];
    return [`${where}: matches none of ${branches.length} alternatives (${branches.map((b) => b[0]).join(' | ')})`];
  }
  if ('const' in schema && value !== schema.const) return [`${where}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`];
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) return [`${where}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const ok = types.some((t) => t === actual || (t === 'integer' && typeof value === 'number' && Number.isInteger(value)) || (t === 'number' && actual === 'number'));
    if (!ok) return [`${where}: expected ${types.join(' or ')}, got ${actual}`];
  }
  const errors: string[] = [];
  if (Array.isArray(value)) {
    const prefix = Array.isArray(schema.prefixItems) ? (schema.prefixItems as JsonSchema[]) : [];
    value.forEach((item, i) => {
      if (i < prefix.length) errors.push(...validate(item, prefix[i], rootSchema, `${where}[${i}]`));
      else if (schema.items === false) errors.push(`${where}[${i}]: no item allowed here`);
      else if (schema.items !== undefined) errors.push(...validate(item, schema.items as JsonSchema, rootSchema, `${where}[${i}]`));
    });
  } else if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const r of (schema.required ?? []) as string[]) if (!(r in obj)) errors.push(`${where}: missing required '${r}'`);
    for (const [k, v] of Object.entries(obj)) {
      if (k in properties) errors.push(...validate(v, properties[k], rootSchema, `${where}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${where}: '${k}' is not in the schema`);
      else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) errors.push(...validate(v, schema.additionalProperties as JsonSchema, rootSchema, `${where}.${k}`));
    }
  }
  return errors;
}
