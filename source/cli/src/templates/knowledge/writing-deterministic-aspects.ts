export const summary =
  'How to write check.mjs: the one check(ctx) contract, the ctx surface, tree-sitter API, allowed reads, observation = invalidation surface, machine-independence, cached-at-fill model, cookbook.';

export const content = `# Writing deterministic aspects

A deterministic aspect ships a \`check.mjs\` file. The check runs locally at zero
LLM cost and returns a \`Violation[]\`. Deterministic aspects do not use reviewer
tiers — \`reviewer.tier:\` is rejected on them.

There is ONE \`check(ctx)\` contract. The function receives a \`ctx\` object exposing
the unit's files, the file system, the graph, and parsers, and returns a
synchronous \`Violation[]\`. A check that only inspects each file's syntax tree and
a check that walks the graph topology are the same contract with different \`ctx\`
usage — there are no separate "styles" to choose between.

## When the lock executes a check

\`check.mjs\` executes in three places: the \`yg check --approve\` fill stage,
\`yg aspect-test\`, and \`yg drill\` (which replays the check over its case corpus).
**Plain \`yg check\` never executes a deterministic check** — it validates the entry
by hashing, exactly like an LLM entry. So CI executes no adopter code; check's cost
is hashing only.

The verdict is cached in the lock like every other verdict. It is reusable while
its inputs are unchanged — the subject files AND every value the check observed
through \`ctx\` (see "observation = invalidation surface" below). A cached
deterministic refusal is final for unchanged inputs; a re-run would reproduce it
by definition.

## The \`yg-aspect.yaml\`

\`\`\`yaml
# .yggdrasil/aspects/my-rule/yg-aspect.yaml
name: MyRule
description: What this rule enforces.
\`\`\`

The aspect's identity is its directory path under \`aspects/\` (here \`my-rule\`) —
there is no \`id:\` field; \`name:\` and \`description:\` are required. The reviewer
kind is inferred from the presence of \`check.mjs\`. The runner detects each file's
language from its extension; there is no \`language:\` field and no \`ctx.language\`.

## Runtime contract

\`\`\`javascript
// check.mjs
export function check(ctx) {
  // ctx.files — the unit's subject files: { path, content, ast }
  //   path:    string source path
  //   content: string raw source text
  //   ast:     tree-sitter Tree (undefined for non-parseable files) — root via file.ast.rootNode
  const violations = [];
  // ... inspect ctx.files, reach ctx.fs / ctx.graph as the rule needs ...
  return violations;  // Violation[] — synchronous only
}
\`\`\`

Rules:
- Named export \`check\`, synchronous. No \`async\`, no \`Promise\`.
- Return an array of \`{ message, file?, line?, column?, kind? }\` objects (use
  \`report()\` for AST-derived positions).
- Do not write files, make network calls, or call \`process.exit\`.
- Do not touch a file outside \`ctx.files\` directly — reach other files only
  through \`ctx.fs\` / \`ctx.graph\` within the allowed reads set.

The runner raises typed runtime errors when the contract is broken. The fill stage
and \`yg aspect-test --node\` run the check through the structure runner, which
raises \`STRUCTURE_CHECK_*\` codes; the ad-hoc \`yg aspect-test --files\` / \`yg drill\`
path uses the AST runner, whose codes are the \`AST_CHECK_*\` equivalents:

| Error code (fill / --node) | Cause |
|---|---|
| \`STRUCTURE_CHECK_FILE_NOT_IN_CONTEXT\` | \`check\` touched a file that is not in \`ctx.files\` |
| \`STRUCTURE_CHECK_ASYNC\` | \`check\` returned a thenable/Promise — it must be synchronous |
| \`STRUCTURE_CHECK_RETURN_SHAPE\` | \`check\` returned a non-array — it must return \`Violation[]\` |
| \`STRUCTURE_CHECK_THROWN\` | \`check\` threw during execution |

A runtime failure at fill time (import error, thrown exception, broken contract)
is an infra disposition: NO entry is written, the pair stays unverified, and the
\`yg check --approve\` summary reports it under \`aspect-check-runtime-error\`. Plain
\`yg check\` sees such a pair simply as \`unverified\`.

## Iterating over the files

A node's mapping may include non-parseable files (e.g. \`.md\`, \`.sh\`,
\`.txt\`). For those files \`file.ast\` is \`undefined\`. (\`.json\` DOES have a
registered grammar, so a JSON file is parseable and gets an AST.) **Always guard
before touching \`file.ast\`**:

\`\`\`javascript
import { walk, report, inFile, closest } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;  // skip non-parseable files (no tree-sitter AST)
    walk(file.ast.rootNode, node => {
      // ... inspect node, push report(file, node, ...) on a hit ...
    });
  }
  return violations;
}
\`\`\`

Content/regex checks that only use \`file.content\` (and never touch
\`file.ast\`) do **not** need this guard — they should iterate all files
including non-parseable ones.

If a rule should apply only to a subset of files, filter on \`file.path\`
(for example with \`inFile(file, { glob: 'src/api/**' })\`).

## Minimal API — imports from \`@chrisdudek/yg/ast\`

| Export | Signature | Purpose |
|---|---|---|
| \`walk(node, visitor)\` | \`(node, (n) => boolean|void) => void\` | DFS traversal; visitor returning \`false\` skips descent into that subtree. Warning: a visitor that returns \`false\` for every non-matching node (not just the ones it means to prune) stops at the very first node — including the root — and silently visits nothing below it; return a bare \`return;\` (undefined) to continue descent, and only return \`false\` where you deliberately want to skip that subtree |
| \`report(file, node, message)\` | \`(file, TreeNode, string) => Violation\` | Build a \`{ file, line, column, message }\` — \`line\` 1-based, \`column\` 0-based |
| \`inFile(file, pattern)\` | \`(file, { glob } | { regex } | { contains }) => boolean\` | Path filter (discriminated object form) |
| \`findComments(target)\` | \`(file) => TreeNode[]\` | Returns comment nodes within a file (language derived from its path) |
| \`closest(node, types)\` | \`(TreeNode, string[]) => TreeNode | null\` | Nearest ancestor whose \`type\` is in \`types\` |

## tree-sitter node API

Each \`node\` object from the AST exposes:

| Property / method | Type | Notes |
|---|---|---|
| \`node.type\` | \`string\` | Grammar node type (e.g. \`'call_expression'\`) |
| \`node.text\` | \`string\` | Raw source text of the node |
| \`node.namedChildren\` | \`TreeNode[]\` | Named (non-anonymous) children |
| \`node.childForFieldName(name)\` | \`TreeNode | null\` | Child at a named grammar field |
| \`node.startPosition\` | \`{ row: number, column: number }\` | Zero-based row and column |
| \`node.parent\` | \`TreeNode | null\` | Parent node |

### Reading node-types.json

To learn the grammar's node types and field names, inspect the
\`node-types.json\` files shipped inside the installed package under
\`dist/grammars/\`. Each file is named after its grammar:

\`\`\`
<yg install>/dist/grammars/tree-sitter-typescript.node-types.json
<yg install>/dist/grammars/tree-sitter-tsx.node-types.json
<yg install>/dist/grammars/tree-sitter-javascript.node-types.json
<yg install>/dist/grammars/tree-sitter-python.node-types.json
\`\`\`

(and so on for every other shipped grammar — one \`.node-types.json\`
per \`.wasm\` file in the same directory.)

Each entry lists its \`type\`, whether it is \`named\`, and the \`fields\`
object whose keys are the field names usable with \`childForFieldName\`.

## Example: forbid direct DB import in API layer

\`\`\`javascript
import { walk, report, inFile } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;  // skip non-parseable files (no tree-sitter AST)
    if (!inFile(file, { glob: 'src/api/**' })) continue;
    walk(file.ast.rootNode, node => {
      if (node.type !== 'import_statement') return;
      const source = node.childForFieldName('source');
      if (source && /^\\"db\\//.test(source.text)) {
        violations.push(report(file, node, 'API layer cannot import from db/ directly'));
      }
    });
  }
  return violations;
}
\`\`\`

## Quick reference — raw tree-sitter API

Common patterns using the direct tree-sitter API. Each node-type row below is a
match to test inside a \`walk\` visitor — the visitor must \`return\` (not
\`return false\`) on non-matching nodes so the walk keeps descending (see the
worked example above); the function-boundary row is the one full \`walk(...)\` call:

| Pattern | Code |
|---|---|
| Call expression | match \`n.type === 'call_expression'\`; callee via \`n.childForFieldName('function')\` |
| Import statements | match \`n.type === 'import_statement'\` |
| Export statements | match \`n.type === 'export_statement'\` |
| Decorators on node | \`node.childForFieldName('decorators')?.namedChildren ?? []\` |
| Modifier keywords | inspect leading children for modifier keyword nodes |
| JSX elements | match \`n.type === 'jsx_element' \\|\\| n.type === 'jsx_self_closing_element'\` |
| PascalCase check | \`/^[A-Z][a-zA-Z0-9]*$/.test(name)\` |
| Node name | \`node.childForFieldName('name')?.text\` |
| Walk with function boundary | \`walk(parent, n => { if (n.type === type) ...; if (isFunction(n)) return false; })\` |
| Nearest ancestor | \`closest(node, types)\` — available in minimal API |
| File-path test | \`inFile(file, { glob \\| regex \\| contains })\` |
| Violation shape | \`{ file, line, column, message }\` — \`column\` is 0-based |

## The ctx surface

When a rule reaches beyond the unit's own files — cross-node consistency, file
existence, directory structure, graph topology — use the rest of \`ctx\`:

\`\`\`typescript
interface Ctx {
  // The node being reviewed
  node: GraphNode;

  // ctx.subject — the unit's subject files. Always File[].
  //   per:file  → single-element array [file]; per:node → the node's subject
  //   set (same array reference as ctx.files for the whole-node case).
  //   Available in both check.mjs and companion.mjs for cross-hook consistency.
  subject: File[];

  // The unit's subject files (scope-driven view; child carve-out applied)
  files: File[];

  // node.files — always the FULL mapped set, unfiltered by scope
  // (reach it via ctx.node.files)

  fs: {
    exists(path: string): 'file' | 'dir' | false;
    list(dir: string): FsEntry[];
    read(path: string): string;
  };

  graph: {
    node(id: string): GraphNode | undefined;
    nodesByType(type: string): GraphNode[];
    relationsFrom(node: GraphNode): Relation[];
    relationsTo(node: GraphNode): Relation[];
    children(node: GraphNode): GraphNode[];
    flowParticipants(flowName: string): GraphNode[];
  };

  // Synchronous — pre-warmed by the runner. Do NOT await.
  parseAst(file: File | string, language: string): unknown;

  parseYaml(file: File | string): unknown;
  parseJson(file: File | string): unknown;
  parseToml(file: File | string): unknown;
}

interface GraphNode {
  id: string;          // node path, e.g. 'billing/cancel'
  type: string;        // node_type id from yg-architecture.yaml
  mapping: string[];   // raw mapping entries from yg-node.yaml
  files: File[];       // full mapped set (child carve-out applied for own node)
  ports: Record<string, { description: string; aspects: string[] }>;
}

interface File {
  path: string;    // repo-relative POSIX path
  content: string; // raw file content
}

interface FsEntry {
  name: string;        // basename only, e.g. 'foo.ts'
  kind: 'file' | 'dir';
}

interface Violation {
  message: string;
  file?: string;    // repo-relative POSIX path
  line?: number;    // 1-based
  column?: number;  // 0-based
  kind?: string;    // do NOT use 'structure-aspect-*' prefix — reserved for runtime
}
\`\`\`

Note \`ctx.files\` (the scope-driven subject view) vs \`ctx.node.files\` (always the
full mapped set). Under \`scope.per: file\`, \`ctx.files\` is the single file; under
\`per: node\` it is the whole subject set.

## parseAst is synchronous

\`ctx.parseAst(file, language)\` returns the parsed tree synchronously. It does
not return a Promise and must not be awaited. The runner pre-warms the AST
cache before invoking \`check(ctx)\`.

\`\`\`javascript
// Correct:
const tree = ctx.parseAst(file, 'typescript');

// Wrong — do NOT do this:
// const tree = await ctx.parseAst(file, 'typescript');
\`\`\`

If \`parseAst\` is called on a file outside the pre-warmed set, the runtime throws
a violation with \`kind: 'structure-aspect-parseast-not-prewarmed'\`. This means
the file is not in the aspect's allowed reads set — see the section below. For
structured data files, prefer \`ctx.parseYaml\`, \`ctx.parseJson\`, or
\`ctx.parseToml\` — also synchronous, no pre-warming requirement.

## Allowed reads set (D9=A)

The runner enforces a strict read boundary. Attempting to read outside it throws
a runtime violation instead of returning data.

This boundary is a read **discipline**, not a security sandbox. \`check.mjs\` runs
in-process (on an auto-sized worker-thread pool during \`--approve\`, for speed) with
full Node privileges — an adversarial check could still write files or open sockets;
the runner does not prevent it. The allow-list scopes which files count as observed
dependencies, not what the process is capable of. Only run aspects you trust.

Paths in the allowed reads set for a node:

- **Own mapping** — files matching the node's \`mapping:\` entries, child carve-out applied.
- **Declared relation targets** — for each relation in \`yg-node.yaml\`, the target
  node's mapping files and their transitive descendants.
- **Ancestor mappings** — files belonging to parent and grandparent nodes.
- **Own descendant mappings** — files belonging to any child or deeper descendant node.

Accessing anything outside this set produces:

| Violation kind | Trigger |
|---|---|
| \`structure-aspect-undeclared-fs-read\` | \`ctx.fs.exists/list/read\` on a path outside the allowed set |
| \`structure-aspect-undeclared-graph-read\` | \`ctx.graph.node/nodesByType\` returning a node outside the allowed set |
| \`structure-aspect-parseast-not-prewarmed\` | \`ctx.parseAst\` on a file not in the pre-warmed set |

If your check needs to reach a node not currently in scope, add an explicit
relation in \`yg-node.yaml\` pointing to that node. Relations are the contract
that widens the allowed reads set.

## Observation = invalidation surface

The verdict's reusability rests on the observation fold. The runner records every
value the check observed through \`ctx\` beyond its subject files — file reads,
directory listings (the sorted name+kind list), existence probes (including
negative \`exists\` results), and graph-node accesses — and folds them into the
pair's hash. A later change to ANY observed value invalidates the verdict and
re-runs the check at the next \`yg check --approve\` (at zero LLM cost).

The authoring edge: **every observation you make widens your invalidation
surface.** Read (and probe) only what the rule actually needs. A check that lists
a whole directory re-runs whenever any file is added to it; a check that reads one
file re-runs only when that file changes. Fewer observations = the verdict
survives longer between re-runs. (When in doubt the runner over-records: a
spurious extra observation costs at worst one free re-run; a missed one would
yield stale green.)

## Machine-independence

Your check runs on whatever machine fills the lock (a developer's machine for
\`--approve\`, or \`aspect-test\`). It must be machine-independent: no local-only
paths, OS path quirks, or line-ending assumptions — the same inputs must yield
the same violations everywhere. Verify with
\`yg aspect-test --aspect <id> --node <path> --check-determinism\`.

## Reserved violation kinds

The \`structure-aspect-*\` prefix is reserved for runtime-emitted violations. Author
code must NOT emit violations with this prefix. Use a plain \`kind\` or omit
\`kind\` entirely for author-defined violations.

Common runtime kinds (for reference, not for author use):

- \`structure-aspect-undeclared-fs-read\`
- \`structure-aspect-undeclared-graph-read\`
- \`structure-aspect-parseast-not-prewarmed\`

## Common helpers

The same AST helpers are re-exported from \`@chrisdudek/yg/structure\`. These are
useful when your check also inspects parsed AST trees via \`ctx.parseAst\`:

| Export | Signature | Purpose |
|---|---|---|
| \`walk(node, visitor)\` | \`(node, (n) => boolean|void) => void\` | DFS traversal; visitor returning \`false\` skips subtree. Warning: returning \`false\` for every non-matching node (rather than just the ones you mean to prune) stops the walk at the root; use a bare \`return;\` to continue descent |
| \`closest(node, types)\` | \`(TreeNode, string[]) => TreeNode | null\` | Nearest ancestor of one of the given types |
| \`report(file, node, message)\` | \`(file, TreeNode, string) => Violation\` | Build \`{ file, line, column, message }\` — line 1-based, column 0-based |
| \`inFile(file, pattern)\` | \`(file, { glob } | { regex } | { contains }) => boolean\` | Path filter |
| \`findComments(target)\` | \`(file) => TreeNode[]\` | Returns comment nodes |

These helpers are optional — most graph-shape checks work purely with \`ctx.graph\`
and \`ctx.fs\` without parsing AST trees at all.

## Cookbook

### Cookbook 1: sibling-test-file

Every node of type \`command\` must have a sibling test in a separate test-suite
node. The command node reaches that node through a declared relation — the
cross-node lookup a per-file check cannot express. Declare it in the command
node's \`yg-node.yaml\`: \`relations: [{ type: uses, target: tests/unit }]\`.

\`\`\`javascript
// .yggdrasil/aspects/sibling-test-file/check.mjs
export function check(ctx) {
  const violations = [];
  const sourceFile = ctx.node.files[0];
  if (!sourceFile) return violations;
  const stem = sourceFile.path.split('/').pop().replace(/\\.ts$/, '');
  const expected = \`/\${stem}.test.ts\`;

  // Reach the test-suite node via the declared relation. ctx.graph.node throws
  // if the target is outside the allowed read boundary (reachable only via
  // ancestors, own descendants, or a declared relation) — surface that as an
  // actionable fix.
  let testSuite;
  try {
    testSuite = ctx.graph.node('tests/unit');
  } catch {
    violations.push({
      file: sourceFile.path,
      message: "Cannot reach 'tests/unit' — add relations: [{ type: uses, target: tests/unit }] to this node's yg-node.yaml.",
      line: 1,
      column: 1,
    });
    return violations;
  }
  if (!testSuite) return violations; // reachable but not present — nothing to check

  const tests = collectFiles(testSuite, ctx);
  if (!tests.some(f => f.path.endsWith(expected))) {
    violations.push({
      file: sourceFile.path,
      message: \`Missing sibling test '\${stem}.test.ts' under tests/unit/.\`,
      line: 1,
      column: 1,
    });
  }
  return violations;
}

function collectFiles(node, ctx) {
  const out = [...node.files];
  for (const child of ctx.graph.children(node)) out.push(...collectFiles(child, ctx));
  return out;
}
\`\`\`

The relation is what makes the test-suite node reachable: \`ctx.graph\` exposes only
this node, its ancestors, and nodes it declares a relation to.

### Cookbook 2: knowledge-topic-consistency

Every knowledge topic file in \`templates/knowledge/*.ts\` must be registered in
\`templates/knowledge/index.ts\`. Uses \`ctx.fs.list\` and \`ctx.fs.read\`.

\`\`\`javascript
// .yggdrasil/aspects/knowledge-topic-consistency/check.mjs
export function check(ctx) {
  const violations = [];
  const dir = 'source/cli/src/templates/knowledge';
  const entries = ctx.fs.list(dir);
  const topicFiles = entries
    .filter(e => e.kind === 'file' && e.name.endsWith('.ts') && e.name !== 'index.ts')
    .map(e => e.name.replace(/\\.ts$/, ''));
  const indexContent = ctx.fs.read(\`\${dir}/index.ts\`);
  for (const topic of topicFiles) {
    if (!indexContent.includes(topic)) {
      violations.push({
        message: \`Knowledge topic '\${topic}' not registered in index.ts\`,
        file: \`\${dir}/index.ts\`,
        line: 1,
        column: 1,
      });
    }
  }
  return violations;
}
\`\`\`

Note: the \`ctx.fs.list(dir)\` call folds the directory's name list into the
verdict's observation set, so adding or removing a topic file re-runs this check
automatically — exactly the invalidation the rule wants.

### Cookbook 3: child-type composition

Every child of a node of type \`engine\` must itself be of type \`engine-component\`.
Uses \`ctx.graph.children\`.

\`\`\`javascript
// .yggdrasil/aspects/engine-composition/check.mjs
export function check(ctx) {
  const violations = [];
  if (ctx.node.type !== 'engine') return violations;
  for (const child of ctx.graph.children(ctx.node)) {
    if (child.type !== 'engine-component') {
      violations.push({
        message: \`Engine '\${ctx.node.id}' has child '\${child.id}' of type '\${child.type}'; expected 'engine-component'.\`,
      });
    }
  }
  return violations;
}
\`\`\`

Child nodes are always in the own descendant mappings channel — no additional
relation declarations are required to access them via \`ctx.graph.children\`.

Invalidation note: reading \`ctx.node.type\` or \`ctx.node.ports\` folds the reviewed
node's identity (its \`yg-node.yaml\` bytes) into the verdict — exactly as a
\`ctx.graph.node(<self>)\` call would — so a later change to the node's type or
ports re-runs the check (at zero LLM cost) instead of leaving a stale-green
verdict. (\`ctx.graph.children\` folds each child's identity too, so a child's
type change invalidates as well.) Reading only \`ctx.node.id\`, \`ctx.node.mapping\`,
or \`ctx.node.files\` does not add this fold — \`id\` and mapping are already pinned
by the node path and subject-file hashes.

## Testing with yg aspect-test

Run a deterministic aspect's \`check.mjs\` live, without writing the lock. Scope it
either to a graph node or to ad-hoc files:

\`\`\`bash
# Graph-scoped: run the check against a named node
yg aspect-test --aspect sibling-test-file --node orders/handler

# Ad-hoc: run the check against specific files
yg aspect-test --aspect no-sync-fs --files src/orders/handler.ts src/other.ts

# Verify the check is deterministic (same violations on every run)
yg aspect-test --aspect sibling-test-file --node orders/handler --check-determinism
\`\`\`

Every run leads with a one-line verdict stamp (\`yg aspect-test: satisfied — No
violations.\` or \`yg aspect-test: refused — N violation(s)\`) and ends with the
footer \`diagnostic only — lock unchanged; yg check judges the lock against your
files, not this run\`. Exits 1 if violations exist. Use during \`check.mjs\`
development, against both compliant and non-compliant inputs, to confirm no false
positives and no false negatives. \`--check-determinism\` runs the check twice and
fails if the violation sets differ, catching side effects.

To keep such synthetic test inputs beside the aspect, put them in a \`drills/\`
subdirectory of the aspect folder: that directory name is reserved for
hand-authored check fixtures and is never scanned as an aspect, so a fixture that
happens to contain a \`yg-aspect.yaml\` (or anything the loader could mistake for
one) can never register a phantom aspect.

## Purity rule

The check function is deterministic and synchronous:

- Named export \`check\`, synchronous. No \`async\`, no \`Promise\`.
- Do not write files, make network calls, or call \`process.exit\`.
- Read only within the allowed reads set — reaching outside throws a runtime
  violation.

Respecting purity keeps the check reproducible: the same inputs must always
yield the same violations, which is what \`--check-determinism\` verifies.

Note: \`companion.mjs\` (the LLM add-on hook) MAY be async — it exports
\`async function companion(ctx)\`. \`check.mjs\` must remain synchronous. The two
files are separate contracts: one for deterministic verdict computation
(\`check.mjs\`), one for per-unit companion file resolution (\`companion.mjs\`).
\`companion.mjs\` shares the same allowed-reads boundary as \`check.mjs\` and
also folds everything it reads to decide (read one file via \`ctx.fs.read\`,
don't scan a node via \`ctx.graph\`) into the pair's hash — editing a resolved
companion file re-verifies only pairs that read it, exactly like an
observation fold in a deterministic verdict.

## Suppression in deterministic aspects

\`\`\`typescript
// yg-suppress(my-aspect/id) reason — suppresses following line
someCall();

// yg-suppress-disable(my-aspect/id) reason
someCall();
// yg-suppress-enable(my-aspect/id)

// yg-suppress-disable(*) reason — all deterministic aspects in range
// yg-suppress-enable(*)
\`\`\`

A specific \`enable(<id>)\` does NOT punch through \`disable(*)\`.
Full delimiter table and multi-language bracket syntax: \`yg knowledge read suppress-syntax\`.

## Adoption workflow

Deterministic aspects follow the same three-level status as LLM aspects:

- **draft** — produces no expected pairs; \`check.mjs\` is never executed. Zero
  cost. Use while authoring.
- **advisory** — runs at fill time; violations render as warnings. Does not block CI.
- **enforced** — runs at fill time; violations block \`yg check\`. Default.

Recommended path: start at \`draft\`, iterate with \`yg aspect-test\` until the check
returns correct violations on test inputs, promote to \`advisory\` to gather signal
across the repo, then promote to \`enforced\` when the rule is confirmed stable.

For full status mechanics: \`yg knowledge read aspect-status\`.
`;
