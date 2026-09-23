import { walk, report, inFile } from '@chrisdudek/yg/ast';

// Ambient runtime state, matched as a member REFERENCE rather than only as a
// call: `Date.now.bind(Date)`, `const clock = Date.now` or `opts.now ?? Date.now`
// read the clock just as surely as `Date.now()`, and a check that only saw calls
// passed every one of them.
const AMBIENT_MEMBERS = new Map([
  ['Date.now', 'the wall clock'],
  ['Math.random', 'a random source'],
  ['performance.now', 'a monotonic clock'],
  ['process.hrtime', 'a high-resolution clock'],
  ['process.env', 'the environment'],
  ['process.stdout', 'the process output stream (writes and its isTTY state)'],
  ['process.stderr', 'the process error stream (writes and its isTTY state)'],
]);

// The two homes a direct-nondeterminism failure can occur in: the CLI's own
// engine layer (core/**/*.ts) and this repo's own rule-script implementations
// (.yggdrasil/aspects/*/check.mjs, wherever they sit — including nested under
// a drill corpus, which is why both globs carry a leading '**/'). A rule
// script that reads the clock or a random source is exactly the same failure,
// just running as a graph rule instead of shipped CLI source.
function isCheckedFile(file) {
  return inFile(file, { glob: '**/src/core/**/*.ts' }) || inFile(file, { glob: '**/.yggdrasil/aspects/*/check.mjs' });
}

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    if (!isCheckedFile(file)) continue;

    walk(file.ast.rootNode, (node) => {
      // `new Date()` with no arguments reads the wall clock; `new Date(ts)` is a
      // pure conversion of an injected value and stays allowed.
      if (node.type === 'new_expression') {
        const ctor = node.childForFieldName('constructor');
        const args = node.childForFieldName('arguments');
        if (ctor && ctor.text === 'Date' && (!args || args.namedChildCount === 0)) {
          violations.push(
            report(file, node, `'new Date()' reads the wall clock — this file must receive the time as an injected parameter`),
          );
        }
        return;
      }

      // Any reference to an ambient member — called, bound, stored or passed.
      // Matching the innermost `object.property` pair reports `process.stdout.write`
      // once (at `process.stdout`), never again for the outer member.
      if (node.type === 'member_expression') {
        const obj = node.childForFieldName('object');
        const prop = node.childForFieldName('property');
        if (!obj || !prop) return;
        const key = `${obj.text}.${prop.text}`;
        const what = AMBIENT_MEMBERS.get(key);
        if (what === undefined) return;
        violations.push(
          report(file, node, `direct '${key}' reference reads ${what} — this file must not access runtime state directly; inject via parameter`),
        );
      }
    });
  }
  return violations;
}
