# Reviewers

Aspects are verified by reviewers. Yggdrasil ships three reviewer kinds — all operate on the same aspect-node-flow graph; the kind is inferred from which rule source file is present in the aspect directory.

- **LLM reviewer** (inferred when `content.md` is present): ships a `content.md` rule file. An LLM reads the rule and the node's source code, then accepts or rejects. An LLM aspect may also ship an optional `companion.mjs` hook — see [Per-unit companion files](#per-unit-companion-files) below.
- **Deterministic reviewer** (inferred when `check.mjs` is present): ships a `check.mjs` module run by a deterministic runner at zero LLM cost. The check returns a `Violation[]` — no LLM, no nondeterminism, no per-call cost. There is one `check(ctx)` contract: the check receives the node, its subject files (each with a tree-sitter parse tree via `file.ast` when the language has a grammar), the file system, and the graph topology, and can use any of them — inspect a single file's parse tree for syntactic rules, or read related nodes and the file system for cross-node and structural rules. See `yg knowledge read writing-deterministic-aspects`.
- **Aggregating aspect** (inferred when neither rule source is present but `implies:` is declared): a content-less, check-less named bundle. It has no own reviewer and produces no own verdict. When effective on a node, it expands its `implies:` list and each implied aspect is verified individually. Use it to attach a multi-rule contract as one named entry point backed by N atomic child aspects.

The `reviewer:` block in `yg-aspect.yaml` is **optional** — kind is inferred automatically. If present, an explicit `reviewer.type` must agree with the inferred kind; `yg check` enforces this. A `content.md` and a `check.mjs` are mutually exclusive on the same aspect. An aspect with neither rule source and no `implies:` is rejected. Deterministic aspects run locally at zero LLM cost.

---

## Choosing a reviewer

| Reviewer | Use when the rule is… | Examples |
|---|---|---|
| **Deterministic** | a **programmatic** check — either a per-file **syntactic** rule or a **graph/file-system shape** rule spanning more than one file | Forbidden API calls (`fs.readFileSync`, `eval`); naming conventions (PascalCase exports); import restrictions (no cross-module relatives); missing guards (`@Log` decorator required); "every command node has a sibling test file"; "every child of an engine node is of type engine-component"; "every knowledge topic is registered in the index" |
| **LLM** | a **semantic judgment** a human reviewer would read surrounding context to make | "Mutations must emit audit events"; "Error responses must follow the API contract"; "Business logic must respect rounding rules"; "This handler must validate input semantically" |

If a programmatic check can decide the rule — a regex or AST traversal over a single file, or a graph-aware check spanning multiple files and the file system — use the deterministic reviewer. If a human reviewer would need to read surrounding context to decide, use LLM. The deterministic reviewer runs locally at zero LLM cost; only the LLM reviewer makes paid calls.

The `reviewer:` block is **optional** — reviewer kind is inferred from rule-file presence (`content.md` → LLM, `check.mjs` → deterministic, neither + `implies:` → aggregate). Declare a `reviewer:` block only when you need to set `reviewer.tier:` on an LLM aspect. If you do declare a `reviewer.type`, it must agree with the inferred kind. LLM aspects may declare `reviewer.tier:` to opt into a specific tier from `yg-config.yaml` — see [Reviewer tiers](./configuration.md#reviewer-tiers) for tier configuration.

---

## LLM reviewer

The LLM reviewer is a separate LLM call from the coding agent — one LLM verifying the work of another. `yg check --approve` assembles each unverified LLM pair into one prompt — the aspect's `content.md` plus the subject files for that pair (the whole node under `per: node`, a single file under `per: file`). The reviewer also receives any reference files declared on the aspect, presented as authoritative context (not under review). It responds with SATISFIED or NOT SATISFIED, and the verdict is recorded in the lock. Each unverified LLM pair costs one reviewer call, multiplied by the tier's consensus count.

**Draft aspects produce no pairs.** When an aspect's effective status on a node is `draft`, no pair is expected for it — there is nothing to verify and nothing to record (`yg aspect-test` can still run a draft aspect live — diagnostic only, the lock is never written). Aspects with effective status `advisory` or `enforced` are verified normally; the level only changes how a refused or unverified pair renders in `yg check` (warning vs. error). Verdicts survive status flips, including a `draft` round-trip — returning an aspect to enforced re-uses the recorded verdict for unchanged inputs. See [Aspect Status](/aspect-status) for the lifecycle.

**LLM verdicts are not deterministic.** The same code against the same rule can come back SATISFIED on one run and NOT SATISFIED on another — most often on borderline rules. To avoid laundering a refusal into an approval, a recorded refusal is final for unchanged inputs: re-running `yg check --approve` does not re-roll it. The three honest ways out are fix the code, sharpen the rule (which re-verifies every pair of the aspect — check `yg impact --aspect` first), or add a `yg-suppress` marker with your sign-off. Manage variance up front by writing rules that are concrete and decidable rather than vague, by preferring a `deterministic` `check.mjs` whenever a rule is programmatically checkable (zero LLM cost, identical result every run), and by raising `consensus` on high-stakes or noisy aspects so a majority vote smooths out single-call variance. To explore whether the rule text is the problem, use `yg aspect-test` — a diagnostic re-run that never writes the lock.

### Directory structure

```
.yggdrasil/aspects/
  requires-audit/
    yg-aspect.yaml       ← reviewer: { type: llm }
    content.md           ← the rule, in plain Markdown
```

### `yg-aspect.yaml`

```yaml
name: Audit Logging
description: "Every mutation must emit an audit event"
reviewer:
  type: llm
```

### Writing `content.md`

Write rules the way you would write a code review comment — clear, specific, actionable.

```markdown
<!-- .yggdrasil/aspects/requires-audit/content.md -->
Every public mutation endpoint must emit an audit event before returning.

Use the shared `auditLog.emit()` utility. Do not build custom audit logic.
The event must include: user ID, action, timestamp, affected resource ID.
```

**Effective `content.md` is specific, not aspirational:**

- ✅ "Use `auditLog.emit()` before return. Event must include userId, action, timestamp, resourceId."
- ❌ "Audit logging should be appropriate and comprehensive."

The reviewer compares text against code. Vague rules produce vague verdicts; specific rules produce reproducible verdicts.

### Output and false positives

```text
$ yg check --approve

  payments / requires-audit — REFUSED
    chargeCard() does not emit an audit event.
    No call to auditLog.emit() found in any mutation path.

yg check: FAIL  Errors: 1  Warnings: 0
Next: fix the violation, then re-run: yg check --approve
```

If the reviewer rejects compliant code, the fix is improving the aspect's `content.md` — make the rule clearer and more specific. Sharpening the rule re-verifies every pair of the aspect. The escape hatch is better rules, not bypassing enforcement.

### Cost

Cost is counted per pair. A `per: node` aspect on a node with 5 source files is one pair — one LLM call (times consensus). A typical fill for a node with 3 `per: node` aspects makes 3 LLM calls. A `per: file` aspect over those 5 files is 5 pairs — 5 calls. Using a fast model (Haiku, GPT-4o-mini, Gemini Flash) keeps cost under a few cents per call. Deterministic pairs are free regardless of scope. For local review, Ollama runs on your machine with no API cost. See [Configuration](/configuration) for provider setup.

### Consensus

Set `consensus: 3` (or any odd integer) on a tier in `yg-config.yaml` to run multiple review passes and take the majority vote. Higher confidence, proportionally higher cost. Useful for high-stakes aspects or noisy borderline rules.

```yaml
reviewer:
  tiers:
    thorough:
      provider: anthropic
      consensus: 3          # majority vote — 2 of 3 must agree
      config:
        model: claude-opus-4-7
```

---

## Per-unit companion files

An LLM aspect may ship an optional `companion.mjs` alongside `content.md`. For each verification unit, the runner executes the hook to resolve 0–N read-only companion files from other nodes, and injects those files into that unit's reviewer prompt only. This lets the reviewer see exactly one paired counterpart per unit — a scenario document with its matching test spec, a migration with its schema, a handler with its contract — without embedding the entire related node's source in every prompt.

`companion.mjs` is an **add-on to an LLM aspect, not a new reviewer kind**. Reviewer kind inference is unchanged: `companion.mjs` without `content.md` is a validator error (`aspect-companion-without-content`). `companion.mjs` alongside `check.mjs` is also a validator error (`aspect-companion-with-check`) — companions apply to LLM aspects only. Both codes are blocking errors that prevent `yg check` from passing.

### Directory structure

```
.yggdrasil/aspects/
  scenario-faithfulness/
    yg-aspect.yaml     ← reviewer: { type: llm }
    content.md         ← the rule
    companion.mjs      ← per-unit companion hook (optional add-on)
```

Your agent sees `companion.mjs` listed in the `read:` output of `yg context`, alongside `content.md`.

### The `companion(ctx)` contract

`companion.mjs` must export a named function `companion` (not a default export). The function may be async.

```javascript
// companion.mjs — must export a named 'companion' function
export async function companion(ctx) {
  // ctx.subject — the unit's subject file(s):
  //   per:file scope → array containing the single file under review
  //   per:node scope → the node's full subject-file array (same as ctx.files)
  //
  // Read a subject file's content and extract the paired path:
  const text = ctx.subject[0].content;
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return [];   // returning [] is valid — unit reviewed with subject only
  const specPath = m[1].match(/^test:\s*(.+)/m)?.[1]?.trim();
  if (!specPath) return [];
  return [{ path: specPath }];   // return paths, never file content
}
```

**What `ctx` provides:**

- `ctx.subject` — the unit's subject file(s): per:file → single-element array; per:node → the node's full subject set (same reference as `ctx.files`).
- `ctx.files` — all subject files for the unit (same as `ctx.subject` for per:node).
- `ctx.node`, `ctx.graph`, `ctx.fs` — same as the deterministic check context; bounded by the node's allowed-reads.
- `ctx.parseYaml(file)`, `ctx.parseJson(file)`, `ctx.parseToml(file)`, `ctx.parseAst(file, language)` — parse helpers; each accepts a `File` object or a **path string** (they treat the argument as a file path, not raw text). To parse raw frontmatter text extracted from a subject file, use a regex — not `ctx.parseYaml`.

**What the hook returns:**

The hook returns `Array<{ path: string, label?: string }>` — whole files only; there is no line-range or slicing feature. `label` is an optional human-readable tag that appears in the live reviewer prompt. The hook may read and parse files to decide which paths to return, but it returns paths, never file content. What the hook reads to decide also folds into the verdict (not only what it returns). Read the single needed file via `ctx.fs.read`; materializing a whole related node via `ctx.graph` folds that node's entire content into every per-file pair and widens invalidation.

**Purity requirement:** Like `check.mjs`, the companion hook must be pure — no file writes, no network calls, no `process.exit`. An impure hook yields non-deterministic observations; the runner retries once and then fails closed (reported as `aspect-companion-runtime-error`).

Returned paths may be absolute or repo-root-relative. The runner normalizes them to repo-root-relative POSIX, dedupes, and sorts them — so the prompt and the hash are deterministic regardless of the hook's return order. A path that escapes the repo root is an infra-fail (the existing allowed-reads guard).

**Returning `[]` is valid** — the unit is reviewed with only its subject files, and no companion block appears in the prompt. To signal an error condition (a missing required counterpart, for example), throw an exception — the hook's job is to resolve paths, not to judge.

**Parsing frontmatter — use a regex:**

```javascript
// Extract a ---...--- frontmatter block manually (regex):
const text = ctx.subject[0].content;
const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
if (!fmMatch) return [];
const key = fmMatch[1].match(/^test:\s*(.+)/m)?.[1]?.trim();
```

`ctx.parseYaml` treats its argument as a file path, not as a YAML string; to parse text you already hold in memory, use a regex or a manual `---` split.

### Allowed-reads boundary

The companion hook is bounded by the same allowed-reads set as `check.mjs`: the node's own mapping files, its declared relation targets (and their descendants), its ancestor mappings, and its own descendant mappings. To reach a file from another node, declare a relation to that node in `yg-node.yaml`. The boundary is a discipline, not a sandbox — the hook runs with full Node privileges.

### How companion files are injected

Resolved companion files appear in a distinct `<companions>` block in the reviewer prompt, separate from the `<references>` block (static references) and `<source-files>` (the unit's own source). The companions block is absent when the hook returns `[]`. Companion files count toward the tier's `max_prompt_chars` gate, exactly like subject and reference files. On a companion-bearing pair's first fill the prompt-size check runs at fill time, before the reviewer is called (not at `yg check` time), because the companion bytes are only known once the hook resolves — so a too-large companion prompt is caught and billed nothing on that first approve.

**`yg-suppress` is honored only from the `<source-files>` block.** A suppress marker inside a companion file is ignored — companions are read-only reference material, not the unit under judgment.

### Verdict hashing and invalidation

Two optional ingredients fold into the LLM pair's hash only when present, each under its own independent guard:

1. **`companionHash`** — SHA-256 of `companion.mjs` bytes, present whenever the aspect ships `companion.mjs`. Editing `companion.mjs` re-verifies every pair of the aspect (all pairs, because `companionHash` changes for all).
2. **`touched`** — the hook's observations (each companion file the hook resolved and the runner read, plus any `ctx.fs`/`ctx.graph` accesses), folded only when `length > 0`. Editing a resolved companion file re-verifies only the pairs that read it.

**Backward-compatibility is load-bearing.** A plain LLM aspect (no `companion.mjs`) passes neither ingredient — the hash is byte-identical to what was stored before this feature existed. There is no lock-format change, no schema-version bump, and no migration.

Adding `companion.mjs` to an existing LLM aspect introduces `companionHash` on the first fill, which re-verifies that aspect's pairs once (a one-time cost on adoption). After that, edits to companion files cost only the pairs that read them.

### What `yg aspect-test --dry-run` shows

`--dry-run` on a companion-bearing LLM aspect runs the hook live and prints the resolved companion paths and the assembled prompt, but makes no reviewer call and does not touch the lock. The `--files` ad-hoc path (testing against an explicit file list without a node) is not available for companion aspects — the hook requires a node to bound its allowed reads.

### Failure modes — fail closed

Any failure to assemble a companion is an **infra-fail**: nothing is written to the lock, `callsMade` is 0, and the pair stays unverified. `yg check` stays red until the problem is resolved. Infra-fail cases include:

- The hook throws an exception.
- The hook returns a value that is not an array of `{ path }` objects.
- A returned path does not exist on disk.
- A returned path falls outside the node's allowed-reads set (the error names the owning node and the companion's owning node, never the subject file).
- `companion.mjs` fails to import (syntax error, missing dependency).

The hook is a resolver, not a judge — it never emits violations.

---

## Deterministic reviewer

The deterministic reviewer ships a `check.mjs` module run locally at zero LLM cost. Whatever `Violation[]` your `check` function returns is the verdict — no LLM, no nondeterminism, no per-call cost. There is **one** `check(ctx)` contract. The `ctx` exposes everything a check might need: `ctx.node` and `ctx.files` (the subject files, each with a `file.ast` parse tree when the language has a grammar), `ctx.fs` (the file system, within an allowed-reads boundary), and `ctx.graph` (the graph topology). A check uses whichever it needs — inspect a single file's parse tree for a syntactic rule, or read related nodes and the file system for a cross-node structural rule. See `yg knowledge read writing-deterministic-aspects`.

The two subsections below illustrate each end of that range: [parse-tree checks](#parse-tree-checks) for per-file syntactic rules, and [graph-aware checks](#graph-aware-checks) for rules spanning more than one node — but both are the same `check.mjs` contract and the same `reviewer.type: deterministic` field.

### Parse-tree checks

A parse-tree check reads each subject file's tree-sitter parse tree (`file.ast`) and calls your `check(ctx)` function with it. Whatever `Violation[]` you return is the verdict.

#### Directory structure

```
.yggdrasil/aspects/
  async-fs/
    yg-aspect.yaml       ← reviewer: { type: deterministic }
    check.mjs            ← your check function
```

#### `yg-aspect.yaml`

```yaml
name: No Sync FS
description: Forbid synchronous fs calls — use async equivalents
reviewer:
  type: deterministic
```

The `reviewer:` block is optional — the presence of `check.mjs` infers the deterministic kind. If you do declare it, `reviewer.type: deterministic` must agree with the inferred kind. The runner parses each source file by extension — built-in grammars cover TypeScript/TSX/JavaScript, Python, Go, Rust, Java, C#, C, C++, PHP, Ruby, Kotlin, JSON, YAML, and TOML — and passes all files to a single `check.mjs` invocation; a file whose extension has no registered grammar is still passed to the check, just without a parse tree. Per-language file filtering (a `language:` array on the aspect) is designed but not yet built. Everything else (`implies`, `when`, `aspects` on nodes) works identically across both reviewer types.

#### Writing `check.mjs`

```javascript
// check.mjs — must export a named 'check' function (not default)
import { walk, report, inFile } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  // ctx.files — the node's source files, each with a tree-sitter parse tree
  // ... examine ctx.files ...
  return violations;   // return Violation[], synchronous
}
```

`ctx` has shape:

```typescript
interface CheckContext {
  files: SourceFile[];
}

interface SourceFile {
  path: string;       // relative to project root
  content: string;    // raw file content
  ast: Tree;          // tree-sitter parse tree
}

interface Violation {
  file: string;       // relative to project root
  line: number;       // 1-based
  column: number;     // 0-based
  message: string;
}
```

#### End-to-end example — async-fs

```javascript
// .yggdrasil/aspects/async-fs/check.mjs
import { walk, report } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    walk(file.ast.rootNode, node => {
      if (node.type !== 'call_expression') return;
      const fn = node.childForFieldName('function');
      if (fn?.type !== 'member_expression') return;
      const obj = fn.childForFieldName('object');
      const prop = fn.childForFieldName('property');
      if (obj?.text === 'fs' && /Sync$/.test(prop?.text ?? '')) {
        violations.push(report(file, node, `fs.${prop.text} is synchronous — use async equivalent`));
      }
    });
  }
  return violations;
}
```

This flags any call matching `fs.<anythingSync>()` anywhere in the files, across function boundaries.

#### Minimal API

Five exports are available from `@chrisdudek/yg/ast` — no installation required. If `yg` works on the machine, the import resolves at runtime.

```javascript
import { walk, report, inFile, findComments, closest } from '@chrisdudek/yg/ast';

walk(node, visitor)           // DFS traversal; visitor returning false skips subtree.
                              // Warning: returning false on EVERY non-matching node stops
                              // the walk at the root and silently visits nothing — use a
                              // bare `return` to continue descent, and return false only
                              // where you deliberately prune that subtree
report(file, node, message)   // create a Violation — line 1-based, column 0-based
inFile(file, { glob })        // path filter: { glob }, { regex }, or { contains }
inFile(file, { regex })
inFile(file, { contains })
findComments(target)          // comment nodes for a file or subtree
closest(node, types)          // nearest ancestor whose type is in the array
```

Use direct tree-sitter node properties for everything else:

```javascript
node.type                        // grammar node type string
node.text                        // raw source text
node.namedChildren               // named children array
node.childForFieldName('name')   // child at a named grammar field
node.startPosition               // { row, column } — zero-based
node.parent                      // parent node
```

Full type signatures are in the CLI's `dist/ast.d.ts`. Locally installed users get editor completion automatically; global/npx users get runtime resolution.

#### Worked example — before and after

**Rule:** no array-mutation methods called on function parameters.

**Without helpers** (~30 lines):

```javascript
const fnTypes = ['function_declaration', 'function_expression', 'arrow_function', 'method_definition'];
for (const fnType of fnTypes) {
  for (const fn of file.ast.rootNode.descendantsOfType(fnType)) {
    const params = new Set();
    for (const p of (fn.childForFieldName('parameters')?.namedChildren ?? [])) {
      const id = p.childForFieldName('pattern') ?? p.namedChildren[0];
      if (id?.type === 'identifier') params.add(id.text);
    }
    for (const call of fn.descendantsOfType('call_expression')) {
      const fn2 = call.childForFieldName('function');
      if (fn2?.type !== 'member_expression') continue;
      const obj = fn2.childForFieldName('object');
      const prop = fn2.childForFieldName('property');
      if (obj?.type === 'identifier' && params.has(obj.text) &&
          /^(push|splice|pop|sort|reverse)$/.test(prop?.text ?? '')) {
        violations.push({ file: file.path, line: call.startPosition.row + 1, message: '...' });
      }
    }
  }
}
```

**With minimal API** (~10 lines):

```javascript
import { walk, report } from '@chrisdudek/yg/ast';

walk(file.ast.rootNode, fn => {
  if (fn.type !== 'function_declaration') return;
  const params = collectParamNames(fn);
  walk(fn, callNode => {
    if (callNode.type !== 'call_expression') return;
    const fnNode = callNode.childForFieldName('function');
    if (fnNode?.type !== 'member_expression') return;
    const obj = fnNode.childForFieldName('object');
    const prop = fnNode.childForFieldName('property');
    if (obj?.type === 'identifier' && params.has(obj.text) &&
        /^(push|splice|pop|sort|reverse)$/.test(prop?.text ?? '')) {
      violations.push(report(file, callNode, `Mutating parameter via .${prop?.text}() is forbidden`));
    }
  });
});
```

#### Purity rule

`check.mjs` must be pure: **no file writes, no network calls, no `process.exit`**. The runner does not sandbox or enforce this; respecting it is your responsibility. Impure checks produce non-deterministic results and can corrupt the project.

#### Testing parse-tree checks

```bash
# Run an aspect against specific files (diagnostic only — the lock is never written)
yg aspect-test --aspect async-fs --files src/utils/config.ts

# Use a node's mapping as the file list
yg aspect-test --aspect async-fs --node orders/order-service
```

`yg aspect-test` exits 0 for clean, 1 for violations, and never writes the lock. Output:

```text
yg aspect-test: refused — 1 violation
src/utils/config.ts
  L12: fs.readFileSync is synchronous — use async equivalent
```

### Graph-aware checks

A graph-aware check is language-agnostic. It is the same `check.mjs` contract, but instead of leaning on a single file's parse tree it reaches for `ctx.fs` and `ctx.graph` — reading the node, its files, related nodes, and the file system. Use it for cross-node structural rules a parse-tree check cannot express: "every command node has a sibling test file", "every child of an engine node is of type engine-component", "every knowledge topic is registered in the index". See `yg knowledge read writing-deterministic-aspects`.

#### Directory structure

```
.yggdrasil/aspects/
  sibling-test-file/
    yg-aspect.yaml       ← reviewer: { type: deterministic }
    check.mjs            ← your check function
```

#### `yg-aspect.yaml`

```yaml
name: sibling-test-file
description: "Every command node must have a sibling test file"
reviewer:
  type: deterministic
```

Graph-aware aspects do NOT declare a `language:` array — the runner invokes `check.mjs` once per affected node regardless of file types. Setting `reviewer.tier:` on a deterministic aspect is a validator error; tiers apply only to LLM aspects.

#### Writing `check.mjs`

The `check(ctx)` function is synchronous and returns `Violation[]`. The `ctx` object exposes the graph and the file system rather than a single parse tree:

```typescript
interface Ctx {
  node: GraphNode;     // the node being reviewed
  files: File[];       // alias for node.files — own files with child carve-out applied

  fs: {
    exists(path: string): 'file' | 'dir' | false;
    list(dir: string): { name: string; kind: 'file' | 'dir' }[];
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

  // Synchronous — pre-warmed by the dispatcher. Do NOT await.
  parseAst(file: File | string, language: string): unknown;
  parseYaml(file: File | string): unknown;
  parseJson(file: File | string): unknown;
  parseToml(file: File | string): unknown;
}

interface Violation {
  message: string;
  file?: string;    // repo-relative POSIX path
  line?: number;    // 1-based
  column?: number;  // 0-based
}
```

The same helper exports available to parse-tree checks (`walk`, `report`, `inFile`, `closest`, `findComments`) are re-exported from `@chrisdudek/yg/structure` for checks that also inspect parsed trees via `ctx.parseAst`. Most graph-aware checks work purely with `ctx.graph` and `ctx.fs` without parsing any AST.

#### Allowed reads

The graph-aware runner enforces a strict read boundary — reading outside it throws a runtime violation instead of returning data. A node may read its own mapping files, its declared relation targets (and their descendants), its ancestor mappings, and its own descendant mappings. If a check needs to reach a node outside this set, add an explicit relation in `yg-node.yaml` pointing to it — relations are the contract that widens the allowed reads. The boundary is a *discipline*, not a sandbox: `check.mjs` runs with full Node privileges, so keep it machine-independent (no local-only paths, no OS quirks, no line-ending assumptions).

#### The observation model: what invalidates a deterministic verdict

A deterministic verdict is reusable only while everything the check **observed** still hashes to the value it had when the verdict was recorded. As the check runs, the runner records every observation it makes beyond the subject files: each `ctx.fs.read` (with the content hash), each `ctx.fs.list` (with a hash of the directory's entry names), each `ctx.fs.exists` probe (including negative ones — a `false` result is an observation), and each `ctx.graph` access. These observations are folded into the pair's input hash, so a later change to any observed value re-verifies the pair — adding a file the check listed, making a probed path appear, or editing a related node all count.

The practical consequence: **every observation widens your invalidation surface.** Read and probe only what the rule needs, and the verdict survives longer between re-runs.

#### Testing graph-aware checks

```bash
# Test the check against a specific node — diagnostic only, the lock is never written
yg aspect-test --aspect sibling-test-file --node orders/order-service

# Verify the check is deterministic (same violations on every run)
yg aspect-test --aspect sibling-test-file --node orders/order-service --check-determinism
```

`yg aspect-test` exits 1 if violations exist and never writes the lock. Run it against both compliant and non-compliant nodes to confirm no false positives and no false negatives. `--check-determinism` runs the check twice and fails if the violation sets differ — your safeguard against machine-dependent or side-effecting checks.

---

## Suppression — shared across reviewer types

Source code comments can carry a `yg-suppress` marker to waive a specific aspect. All reviewer types honor the same syntax **and the same scope**: a marker's scope is resolved once, deterministically, into exact line ranges, and both reviewer kinds honor those identical ranges.

**Format:** `yg-suppress(<aspect-path>) <reason>`

- `<aspect-path>` — full aspect path (e.g., `cqrs/single-responsibility`)
- `<reason>` — required free-text explanation. Empty or whitespace-only reasons fail with `SUPPRESS_MARKER_MISSING_REASON`.
- Markers must live inside **comment nodes** — string literals are not matched.
- The marker must begin its comment line (after the comment delimiter). A mid-sentence mention of `yg-suppress(...)` in a comment is not a marker.
- In a **Markdown** file, a marker inside a fenced code block (like the examples below) is documentation, not a live waiver — it is not honored and not listed by `yg suppressions`. To place a genuine waiver in Markdown, use an HTML comment **outside** any fence: `<!-- yg-suppress(<aspect-path>) <reason> -->`.

### Single-line suppress

```typescript
// yg-suppress(async-fs) legacy code, refactor tracked in JIRA-456
const data = fs.readFileSync(path, 'utf-8');
```

A single-line marker waives **exactly one line — the immediately following line — for every reviewer kind**. There is no contextual or scope inference: the marker never expands to the surrounding function, class, block, or whole file, and never shrinks. The scope is resolved once, deterministically, into a one-line range that both reviewer kinds honor identically:

- **Deterministic reviewer:** the `check.mjs` reads the resolved range directly and treats the line inside it as satisfied.
- **LLM reviewer:** the reviewer receives the pre-resolved spans in its prompt (a `<suppressed-ranges>` block of exact `(start-line, end-line)` pairs into the source files) and is instructed to honor exactly those lines — it does not re-derive the marker's scope, widen it, or narrow it.

To waive more than one line, use the bracket `disable`/`enable` form below (or a bare `disable`, which runs to end of file) — never a single-line marker.

### Bracket suppress

```typescript
// yg-suppress-disable(async-fs) bootstrap block uses sync reads
const a = fs.readFileSync('a.json', 'utf-8');
const b = fs.readFileSync('b.json', 'utf-8');
// yg-suppress-enable(async-fs)
```

Applies to all lines between `disable` and `enable`. Reason is required on `disable`. Without a closing `enable`, the range extends to end of file. Block comments work too.

### Wildcard

Use `*` to suppress all aspects in a range:

```typescript
// yg-suppress-disable(*) generated block — do not edit
/* ... generated code ... */
// yg-suppress-enable(*)
```

A specific `enable(<id>)` does **not** punch through `disable(*)`. To re-enable a specific aspect inside a wildcard-disabled block, end the wildcard block first.

### Agent behavior

Agents may propose adding a suppress marker but must **never** write one without explicit user confirmation. The reason field is provided or approved by the human, never invented by the agent.

---

## Verdicts and the lock — shared

Both reviewer types record their results the same way: one content-addressed entry per `(aspect, unit)` pair in the lock. Each entry stores the verdict and the hash of the inputs that produced it. On disk the lock is partitioned by reviewer kind — LLM verdicts go to the committed `.yggdrasil/yg-lock.nondeterministic.json`, deterministic verdicts to the gitignored `.yggdrasil/.yg-lock.deterministic.json` cache (rebuilt for free on demand, never committed), with the per-node log/closure baseline in the committed `.yggdrasil/yg-lock.logs.json`. The entry format is identical regardless of which file holds it; see [The lock](/the-lock):

- **LLM pair (without companion):** the hash folds `content.md`, the subject files, the aspect description, the reference files, and the **name** of the resolved tier. The tier's config — provider, model, endpoint, temperature, consensus — is not folded; only its name. Change any folded input → the pair is unverified.
- **LLM pair (with companion.mjs):** additionally folds `companionHash` (SHA-256 of `companion.mjs`) and, when non-empty, the hook's `touched` observations (the companion files the runner read, plus any `ctx.fs`/`ctx.graph` accesses). Both ingredients are folded only when present — a plain LLM aspect's hash is byte-identical to before, with no lock-format change.
- **Deterministic pair:** the hash folds `check.mjs`, the subject files, and the observation set — every `ctx.fs` read, listing, and existence probe and every `ctx.graph` access the check made beyond its subject files (see [the observation model](#the-observation-model-what-invalidates-a-deterministic-verdict) below). Change the check, a subject file, or any observed value → the pair is unverified.

`yg check` by default recomputes each pair's input hash and compares it to the lock — no LLM calls, no provider keys, runs instantly. If `auto_approve` is set to `deterministic` or `full` in `yg-config.yaml`, bare `yg check` may fill pairs automatically (see [Configuration](/configuration#auto-approve-config)); explicit CLI flags always override the config. A source edit and an aspect-content edit both surface the same way: the affected pairs no longer match their recorded hash, so check reports them as unverified until `yg check --approve` fills them again.

### Verdict-events sidecar

Alongside the lock, every `yg check --approve` fill appends a one-line record of each verdict — and each failed attempt — to a local `.yg-events.jsonl` file under `.yggdrasil/`. Each line is a single JSON object describing one filled pair: the aspect, the unit, the reviewer kind, the disposition (approved, refused, or a specific no-write outcome such as an unreachable reviewer, a crashed check, or a malformed suppress marker), and a UTC timestamp; a refusal also carries its reason, and a consensus review carries its vote tally (satisfied of total). By default the file is **local-only telemetry**: it is gitignored, never committed, and **never read back by any check, verification, or render path** — it exists only to make fill outcomes observable across runs (which rules refuse often, which infrastructure paths fail repeatedly), motivating rule-health reporting. A failed append is swallowed and can never change a fill's outcome.

#### Committed, shared record (opt-in)

A team can opt into a **committed, shared** record of LLM verification-fill events with a single config key, `events: { committed_llm: true }` (see [Configuration → events](/configuration#events)). When it is on, each LLM fill event is appended to a committed file, `.yggdrasil/yg-events.llm.jsonl`, instead of the local sidecar — a single home per event, so nothing is double-counted. This file is:

- **LLM-fill only.** Deterministic checks, drill runs, and diagnostic runs always stay in the local sidecar, so the free, keyless CI gate (`yg check --approve --only-deterministic`) never touches the committed file — running it adds nothing and produces zero churn.
- **Union-merged.** `yg init` marks the file `merge=union` in `.gitattributes`, so events appended on different branches combine on merge instead of conflicting.
- **Rationale-stripped.** The refusal reason is omitted from the shared copy (it can carry code fragments); the local copy keeps it.

Readers combine the local sidecar with the committed stream, de-duplicated line by line. Because a machine on an older CLI writes only locally, a reader that surfaces these events notes that older machines do not contribute to the shared record — the committed stream is never assumed complete. The opt-in never affects any verdict or its hash: turning it on or off invalidates nothing.

---

## Edge cases

### LLM reviewer

**Borderline rejections.** Compliant code can be rejected by an LLM that misread the rule. Fix: clarify `content.md`. The escape hatch is better rules, not `yg-suppress`. A recorded refusal is final for unchanged inputs — sharpening the rule is the way to overturn it (and it re-verifies every pair of the aspect).

**Cost spikes when an aspect changes.** Editing a widely-used aspect's content invalidates every pair it produces → N LLM calls to refill. Before such an edit, run `yg impact --aspect <id>` to see the count. `--aspect` also accounts for `companion.mjs` — editing it invalidates every pair of the aspect just as a `content.md` edit does, at the same billed cost. Consider `consensus: 1` for high-fan-out aspects.

**Companion assembly failure.** If the companion hook throws, returns a bad shape, or resolves a path that does not exist or falls outside the allowed-reads boundary, the pair is an infra-fail: nothing is written, the pair stays unverified, and `yg check` stays red. The error message names the owning nodes (source and target) — never the subject file being reviewed. Fix the hook or the relation declarations and re-run `yg check --approve`.

### Deterministic reviewer

**Imports inside `check.mjs`.** Yggdrasil hashes only `check.mjs` itself. If your check imports a helper from `node_modules`, changes to that helper do **not** invalidate the pair — Yggdrasil does not know about transitive dependencies. Guidance: keep all rule logic inside `check.mjs`. If you import a helper, consciously accept that bumping the helper version does not re-verify on its own.

**CLI version pinning.** Tree-sitter grammar versions and helper implementations live inside `@chrisdudek/yg`. A CLI upgrade can shift parse-tree node shapes or helper behavior. The input hash deliberately excludes the CLI version, so upgrading Yggdrasil does not invalidate verdicts. After a CLI upgrade that changes tree-sitter grammar behavior (announced in CHANGELOG), force a re-verification by touching the rule source, or accept that the recorded verdicts stand until their inputs change.

---

## See also

- [How it works](/how-it-works) — the model: rails, the three players, the loop
- [The lock](/the-lock) — how verdicts are stored
- [CLI Reference](/cli-reference) — `yg check --approve`, `yg aspect-test`, `yg aspects`
- [Configuration](/configuration) — reviewer provider setup
- [Conditional Aspects](/conditional-aspects) — `when` predicates for selective aspect application
