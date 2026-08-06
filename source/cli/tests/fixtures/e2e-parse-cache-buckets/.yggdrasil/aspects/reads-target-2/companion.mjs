// Identical logic to reads-target/companion.mjs — a second, independently
// attached aspect used to give a run a SECOND (aspect, node) parse-cache
// bucket alongside reads-target's, on a wholly different node/target pair.
// See that file's header for what the parse (ctx.parseAst, never a no-op),
// the returned label, and the staggered delays all prove.
import { setTimeout as delay } from 'node:timers/promises';

export async function companion(ctx) {
  const subjectPath = ctx.subject[0].path;
  const idx = Number(/(\d+)\.ts$/.exec(subjectPath)?.[1] ?? '0');
  await delay(idx * 25);

  const self = ctx.graph.node(ctx.node.id);
  const out = [];
  for (const rel of ctx.graph.relationsFrom(self)) {
    if (rel.type !== 'uses') continue;
    const target = ctx.graph.node(rel.target);
    if (!target) continue;
    for (const file of target.files) {
      await delay(8);
      const tree = ctx.parseAst(file, 'typescript');
      const match = /export const (\w+)/.exec(tree.rootNode.text);
      const label = match ? match[1] : 'unrecognized';
      out.push({ path: file.path, label });
    }
  }
  if (out.length === 0) {
    throw new Error('reads-target-2 companion: no uses-related target files found');
  }
  return out;
}
