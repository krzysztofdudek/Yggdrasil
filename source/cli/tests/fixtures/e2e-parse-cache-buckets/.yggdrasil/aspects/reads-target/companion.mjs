// Companion resolver shared by both bucket-fixture aspects (this one and
// reads-target-2's identical copy). For every `uses` relation the reviewed
// node declares, it walks every one of the target's files, PARSES each one
// through ctx.parseAst (never a no-op — the parsed tree's own root text is
// what decides the label), and returns one companion descriptor per target
// file. Every subject of this rule on the same node reaches the SAME target
// files, so every one of those parses is a candidate for the fill stage's
// shared per-(aspect, node) parse-cache bucket: with N subjects sharing the
// bucket, the target's files are parsed once total instead of once per
// subject, and a bucket released before the LAST subject settles would hand
// a later subject a freed tree instead of a parsed one.
//
// The subject's own numeric suffix (f1 -> 1, f2 -> 2, ...) staggers each
// subject's start by a small, increasing delay, and each target-file read
// inside the loop is separately delayed too. Neither delay changes anything
// this hook returns — only WHEN each subject reaches its ctx.parseAst calls.
// Spreading those calls out in real wall-clock time is what makes "a bucket
// released after its FIRST member instead of its LAST" observable through a
// real concurrent dispatch: a fast-finishing sibling's release must not free
// the tree a slower, still-in-flight sibling is about to read.
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
      // A genuine tree read, not a no-op: parse the target file and pull the
      // exported identifier's name out of the parsed root node's own text —
      // proof the returned label came from the TREE, not just file.content.
      const tree = ctx.parseAst(file, 'typescript');
      const match = /export const (\w+)/.exec(tree.rootNode.text);
      const label = match ? match[1] : 'unrecognized';
      out.push({ path: file.path, label });
    }
  }
  if (out.length === 0) {
    throw new Error('reads-target companion: no uses-related target files found');
  }
  return out;
}
