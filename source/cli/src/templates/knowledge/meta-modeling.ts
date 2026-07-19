export const summary =
  'Mapping the graph directory into the graph itself — modeling and verifying your own enforcement layer; the four ways a node/aspect reaches a graph-dir file, the consequences, and how to do it without runaway cascades';

export const content = `# Meta-modeling

Meta-modeling is bringing files that live UNDER the graph directory (\`.yggdrasil/\`)
INTO the graph as graph-visible files — so the graph can model and verify its own
enforcement layer (aspect rule files, deterministic checks, node/flow definitions),
not just your application source.

The motivating shape is a feedback loop: a requirements document whose front-matter
names the deterministic check meant to enforce it, plus an LLM aspect that reads
that check and judges whether it actually realizes the requirement. The rules end
up reviewing the rules.

## It is allowed — and opt-in

- **Nothing forbids it.** A node \`mapping:\` may point at a path under the graph
  directory — a literal file path or a glob both work. A graph-directory path is no
  more restricted by LOCATION than the rest of your code (the usual rules still
  hold everywhere: no absolute path, no climbing above the repo root with \`..\`, the
  path must exist on disk, and it can't overlap another node's mapping).
- **Coverage never nags.** The top-level graph directory is excluded from the
  scanned-file universe that powers the "uncovered files" check. So you can model a
  FEW graph-directory files without the coverage gate demanding you cover the rest.
  Meta-modeling is partial and opt-in by construction.

## The four ways a graph-directory file reaches a reviewer

A file under the graph directory can be put in front of a reviewer four ways. They
differ in what they require and what they cost.

1. **Mapping → subject.** Map the file to a node and it becomes one of that node's
   SUBJECT files — reviewed by every aspect effective on the node, and parsed by the
   built-in relation check if it is a parseable language. Mapping is resolved against
   disk, so a graph-directory file mapped this way really does become a subject.
2. **\`references:\` (static).** An LLM aspect's \`references:\` list may name any
   repository-relative file — including one under the graph directory — and its bytes
   travel in every prompt for that aspect. References are gated ONLY by repo-escape;
   they need no mapping and no relation. Use this when the SAME file should be in
   front of the reviewer for every unit of the aspect.
3. **\`companion.mjs\` (per-unit, dynamic).** A companion hook returns paths to inject
   per unit — so each requirement document can pull in a DIFFERENT file (e.g. the
   check named in its own front-matter). A companion-returned path must be
   relation-reachable from the reviewed node (own mapping, a declared relation's
   target, an ancestor, or a descendant). To reach a graph-directory file this way,
   that file must be mapped to a node the reviewed node can reach.
4. **Deterministic \`ctx.fs\` read.** A deterministic check may read a
   relation-reachable graph-directory file through its context object — same
   reachability boundary as a companion.

References (2) need no graph wiring at all; companion (3) and deterministic
\`ctx.fs\` (4) need the target to be relation-reachable, which for a graph-directory
file means mapping it and declaring a relation to its node.

## Consequences (read before you map)

Mapping graph-directory files is not free of effects — it makes them first-class
graph citizens, with the obligations that implies:

- **The relation check parses your mapped code.** A mapped \`check.mjs\` /
  \`companion.mjs\` is a parseable source file; if it statically imports another
  mapped node's code with no declared relation, the built-in relation check refuses
  it. Keep mapped checks self-contained, or declare the relations their imports imply.
- **Aspect cascade reaches the mapped files.** Every aspect effective on the node
  (its own, ancestors', architecture-type defaults, flow-attached) now reviews those
  rule files as subjects. Choose the node's type deliberately and use \`when\` /
  \`scope.files\` so a code-oriented aspect does not fire on a Markdown rule file.
- **Self-reference fans out invalidation.** A meta aspect that reviews another
  aspect's check means editing that check re-verifies BOTH the check's own pairs and
  the meta aspect's verdict over it. Density of invalidation grows; keep the meta
  layer small and targeted.
- **Never map the whole graph directory.** A broad \`**/\` glob over the graph
  directory would pull in the committed verdict-lock files, which change on every
  approve and would never converge. Map narrowly — name the specific rule files you
  intend to model (e.g. one glob over the check files of one area), never the graph
  directory wholesale. (Generated, gitignored state is excluded automatically, but
  the committed lock files are not.)

## Doing it without runaway cascades

The blast radius of a meta aspect is governed by WHERE you attach it and HOW
narrowly you map. Keep it tight:

- **Map narrowly.** Map exactly the rule files you want to model, not their whole
  directory.
- **Attach at the leaf, not a broad ancestor.** An aspect on a high parent cascades
  to every descendant. Put the meta aspect on the narrowest node that owns the files
  it judges.
- **Filter with \`when\` and \`scope.files\`.** These are deterministic and free —
  use them to target exactly the units you mean and exclude the rest.
- **Organize the meta aspects hierarchically.** Aspect ids may be nested in
  directories (a directory with no rule file is a pure organizational grouper), so a
  meta layer can live under its own id prefix and stay legible. See
  \`yg knowledge read aspects-overview\`.

## Worked example: a requirement audits its own enforcer

1. A document node maps your requirement documents. Each document's front-matter
   names the deterministic check meant to enforce it.
2. A second node maps those checks (narrowly), and the document node declares a
   relation to it — so the checks are relation-reachable from the documents.
3. An LLM aspect on the document node ships a \`companion.mjs\` that reads the
   document's front-matter, resolves the named check's path, and returns it. The
   reviewer then sees the requirement prose (subject) plus the check (companion) and
   judges whether the check actually realizes the requirement.
4. Editing the requirement prose OR the check re-runs the judgment — the rule now
   reviews its own enforcer, with no separate test artifact to keep in sync.

If the check named by a requirement is FIXED per aspect rather than per document,
prefer \`references:\` (channel 2) and skip the mapping + relation entirely.
`;
