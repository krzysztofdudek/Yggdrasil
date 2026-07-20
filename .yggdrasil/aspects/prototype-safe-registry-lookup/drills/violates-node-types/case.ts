// Reproduces the node_types bug: a fully unguarded read that immediately
// dereferences the result. For an inherited key the result is a function, and
// `.defaults` on it is undefined — or worse, a real inherited member.
interface TypeDef {
  defaults: string[];
}

const node_types: Record<string, TypeDef> = {
  command: { defaults: ['audit-logging'] },
  module: { defaults: [] },
};

export function defaultsFor(typeId: string): string[] {
  return node_types[typeId].defaults;
}
