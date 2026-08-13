export const summary =
  'The verdict lock: format (v1), pairs/units, hash ingredients + exclusions + observation fold, relation conformance computed live (no cached relation verdict), caching policy (refusals final, three exits), merge procedure, garbage-collection, revert recipe, park-with-draft';

export const content = `# Verification and the lock

Every verdict — an LLM reviewer's judgment and a deterministic check's result
alike — is stored as a content-addressed entry in the lock. The lock is a TRIAD of
files under \`.yggdrasil/\`: \`yg-lock.nondeterministic.json\` (committed — LLM
verdicts) and \`yg-lock.logs.json\` (committed — the per-node log/closure baseline),
plus \`.yg-lock.deterministic.json\` (a gitignored local cache — deterministic-check
verdicts, rebuilt for free on demand; committing them adds nothing but noise). The
in-memory lock is unified \`{ version, verdicts, nodes }\`; the split is only at the
I/O boundary, partitioned by aspect KIND. A verdict is valid exactly while the
inputs that produced it hash to the stored value. Any input change makes the pair
**unverified**; a status flip never does. States are: **verified / unverified /
refused**.

\`yg check\` writes nothing by default — it recomputes each pair's hash and
reports, running no aspect reviewers and making no LLM calls (it does recompute
relation conformance live; see below). Exception: if \`auto_approve\` is set in
\`yg-config.yaml\`, bare \`yg check\` auto-fills — \`deterministic\` mode behaves like
\`--approve --only-deterministic\` (free, keyless, local fills only), \`full\` mode
like \`--approve\` (may call the reviewer). Explicit CLI flags (\`--approve\`,
\`--no-approve\`, \`--only-deterministic\`) ALWAYS override \`auto_approve\`. CI and
pre-commit should always use the explicit flag form to stay key-free and
deterministic regardless of project config. \`yg check --approve\` fills every
unverified pair it answers for and then reports (the whole project, or — under
progressive mode — every free check plus the reviewer work your change is
accountable for). With \`--only-deterministic\` it fills ONLY
deterministic pairs (free, keyless) and writes ONLY the gitignored cache — never
the committed files — so it is the CI / pre-commit gate (a fresh checkout has no
deterministic cache, so this rematerializes it; it also re-hashes the committed
LLM verdicts, catching a stale one). These are the only writers of verdicts (with
\`yg log merge-resolve\` writing the per-node log baseline into
\`yg-lock.logs.json\`).

## Pairs and units

Verification runs per \`(aspect, unit)\` **pair**. A **unit** is the subject of one
verification, set by the aspect's \`scope\`:

- \`scope.per: node\` (default) — one unit per node: the whole node. One verdict
  over all the node's subject files.
- \`scope.per: file\` — one unit per subject file. One verdict each.

The **subject set** is the node's mapped files (child carve-out applied) narrowed
by \`scope.files\` (absent filter = all mapped files; LLM aspects additionally drop
binary files, which cannot enter a prompt). An empty subject set produces no
pairs on that node — a legitimate vacuous pass, no verdict, no entry.
\`yg context --node\` shows the per-aspect subject-file count so a mis-written
\`scope.files\` is observable.

**The gitignore trap.** Mapping expansion is a disk walk that SKIPS anything
\`.gitignore\` excludes — like the coverage walk, it never consults the git
index. So a file that is git-tracked AND gitignore-matched (e.g. force-added
with \`git add -f\`, or gitignored only after it was tracked) is invisible to
coverage and to mapping alike, no matter what directory or glob mapping it
falls under: it ships in the repository, yet nothing that reads the disk walk
ever sees it. \`yg check\` catches this — the ONE remaining git consumer in the
whole coverage surface, comparing real \`git ls-files\` output against the disk
walk — as \`tracked-file-gitignored\`, mirroring the coverage tiers exactly
(same absolute-exclusion authority, \`partitionByCoverageTier\`): error under a
\`coverage.required\` root, warning otherwise, and no issue at all under a
\`coverage.excluded\` root — the same exclusion authority every other coverage
check honors, so an excluded area never gets flagged here either. Either
un-ignore the file or untrack it (\`git rm --cached\`). One exemption beyond the
tiers: a file named DIRECTLY in a mapping entry (not swept in via a directory
or glob) is hashed and reviewed regardless of gitignore status — expansion
only consults \`.gitignore\` when expanding a directory or glob, never for a
literal file entry — so it was never actually invisible, and
\`tracked-file-gitignored\` leaves it to the mirror case instead of also
flagging it. The mirror case, \`file-mapping-gitignored\` (a mapping entry
names a gitignored file directly — tracked or not; the literal entry keeps
the file reviewed, but the claim conflicts with \`.gitignore\`: either
un-ignore the file, or it does not belong in the mapping), stays a blocking
structural error. Both are live on every \`yg check\`, no \`--approve\` needed.

## Lock format

\`\`\`jsonc
{
  "version": 1,                              // lock FORMAT version
  "verdicts": {
    "<aspectId>": {                          // keys code-point-sorted at every level
      "node:billing/cancel":   { "hash": "<inputHash>", "verdict": "approved" },
      "file:src/billing/x.ts":  { "hash": "<inputHash>",
                                  "reason": "<violation report>", "verdict": "refused" },
      "node:billing/notify":    { "hash": "<inputHash>",
                                  "touched": [["read:src/shared/codes.ts", "<sha256>"],
                                              ["list:src/billing", "<sha256>"]],
                                  "verdict": "approved" }
    }
  },
  "nodes": {
    "billing/cancel": {                       // present ONLY when log_required and/or a log.md exists
      "source": "<sha256>",                  // source fingerprint — log gate basis; ONLY for log_required nodes
      "log": { "last_entry_datetime": "<ISO>", "prefix_hash": "<sha256>" }
    }
  }
}
\`\`\`

- The unit key is prefixed: \`node:<model-relative path>\` or
  \`file:<repo-relative POSIX path>\`. The entry's aspect determines its reviewer
  kind — entries carry no kind marker.
- \`reason\` is stored only on a \`refused\` entry (the reviewer's violation report,
  or a deterministic check's recorded violations) so plain \`yg check\` renders the
  violation without re-running anything.
- \`touched\` appears on deterministic entries AND on companion-bearing LLM
  entries, recording observations OUTSIDE the subject set (see the observation
  fold below). Every deterministic entry carries it — possibly \`[]\` when the
  check observed nothing beyond its subject files. A companion-bearing LLM
  entry carries \`touched\` only when the hook observed files beyond the subject
  set (length > 0); plain LLM entries without \`companion.mjs\` omit the key
  entirely.
- \`nodes.<path>\` carries the source fingerprint (the log gate's contract,
  \`yg knowledge read log-management\`) and the append-only log integrity baseline.
  The source fingerprint is the log gate's drift basis, so it is recorded ONLY for
  \`log_required\` nodes — a non-log_required node gets a \`nodes\` entry only when it
  owns a \`log.md\` (then holding just the \`log\` baseline, no \`source\`).
- Empty section ⇒ no file. Each of the three split files is written ONLY when its
  section is non-empty; when empty it is not written at all (an existing empty husk
  is removed). So a repo with no LLM aspects has no \`yg-lock.nondeterministic.json\`,
  one with no \`log_required\` node and no \`log.md\` has no \`yg-lock.logs.json\`, and
  one with no deterministic aspects has no \`.yg-lock.deterministic.json\`. readLock
  treats an absent file as empty state, so this is transparent to every reader — a
  repo only carries the lock files it actually needs.
- The built-in relation-conformance check is NOT stored in the lock — it is
  recomputed live on every \`yg check\`. The lock holds only aspect \`verdicts\`
  and per-node \`nodes\` facts; there is no relation section. See "Relation
  conformance — computed live" below.
- Serialization is canonical: code-point-sorted keys, stable formatter, trailing
  newline — so git's line merge aligns with entry boundaries.

**On-disk triad (the split).** The object above is the UNIFIED in-memory lock;
on disk it is partitioned across three files, read back into one and split again
only at the I/O boundary:
- \`yg-lock.nondeterministic.json\` (committed) — \`verdicts\` of LLM aspects.
- \`yg-lock.logs.json\` (committed) — the \`nodes\` section.
- \`.yg-lock.deterministic.json\` (gitignored) — \`verdicts\` of deterministic aspects.

The partition key is the aspect's KIND, NOT the entry's \`touched\` field: a
companion-bearing LLM entry also carries \`touched\`, so partitioning by \`touched\`
would misfile an expensive committed LLM verdict into the throwaway cache. An
aspect is wholly one kind, so the two verdict files hold disjoint \`aspectId\`
namespaces and merge-on-read is a plain union. The committed files keep the same
take-a-side merge story as the old single file; the gitignored cache never
conflicts. A fresh checkout has no deterministic cache, so those pairs read as
\`unverified\` until \`yg check --approve --only-deterministic\` rematerializes them
(free, keyless).

## inputHash — the frozen contract

The hash folds, for both kinds:

\`\`\`
aspect:  <aspect id>
scope:   <canonical scope; absent normalizes to {per: node, files: none}>
node:    <owning node path>                 // pins per-file units to their context
rule:    sha256(content.md | check.mjs bytes)
files:   [ [path, sha256(bytes)], ... ]     // subject files, sorted
verdict: "approved" | "refused"             // the discrete token — tamper evidence
\`\`\`

LLM pairs additionally fold their prompt inputs: the aspect description, each
reference \`[path, sha256(bytes), description]\`, and the resolved tier's NAME.
The tier's config (provider, model, endpoint, temperature, consensus, api_key,
timeout) is NOT a verdict input — only the name folds in, so a named tier can be
re-pointed at a different reviewer without invalidating any recorded verdict.

LLM pairs that ship \`companion.mjs\` additionally fold:
\`\`\`
companionHash: sha256(companion.mjs bytes)   // present when aspect ships companion.mjs,
                                             // independent of whether the hook resolved files
\`\`\`
The stored \`touched\` observations (hook's reads beyond the subject set) are
also folded into the hash — on re-validation (\`yg check\`), companion hash is
re-computed from the \`companion.mjs\` bytes and the stored \`touched\` list is
re-hashed. The companion hook is NOT re-run at re-validation time; no LLM
call is made.

The fold captures every out-of-subject file the hook reads to decide. A
companion that materializes a whole related node via \`ctx.graph\` therefore
folds that node's entire content into the pair, widening invalidation across
the node; read the single needed file via \`ctx.fs.read\` to keep per-unit
isolation.

Deterministic pairs additionally fold the **observation set** — everything the
check observed through \`ctx\` beyond its subject files, recorded by the runner:

\`\`\`
read:<path>            → sha256 of the file bytes read (or 'missing' if absent)
list:<dir>             → sha256 of the sorted entry name+kind list (or 'missing')
exists:<path>          → sha256 of the returned token ('file' | 'dir' | 'false')
graph:<node>           → sha256 of that node's yg-node.yaml bytes ('missing' if absent)
graph-children:<node>  → sha256 of the sorted child node-id list of <node>
graph-bytype:<type>    → sha256 of the sorted node-id list of <type> (within reach)
graph-flow:<flow>      → sha256 of the sorted participant node-id list of <flow>
\`\`\`

Observation-completeness is load-bearing: a deterministic verdict is reusable
only if NO observed value changed — including negative \`exists\` probes, negative
node lookups (a node that was absent and is later created), directory listings,
and SET membership (an aspect that asks "which nodes are children of X / of type
Y / participate in flow Z" records the membership, so adding or removing a node
re-verifies). When in doubt the runner over-records: a spurious extra observation
costs at worst one free re-run; a missed one yields a stale-green verdict.

### Excluded from the hash, deliberately

- **\`status\`** — \`advisory ↔ enforced ↔ draft\` flips never invalidate a verdict
  (rendering only).
- **\`reason\`** / free-text output — only the discrete verdict token is folded.
- **Node description** — not hashed, AND not sent to the reviewer. It is
  documentation for people reading the graph; editing one re-verifies nothing
  because nothing that was judged changed. (The ASPECT description IS both
  hashed and sent — that one is part of the rule.) The node's PATH is sent, and
  is hashed. Every other prompt ingredient is folded too, which is what lets a
  verdict record its prompt's size and be believed — see the size note below.
- **Tier config** — provider, model, endpoint, temperature, consensus, api_key,
  and timeout. Only the tier NAME folds into the hash; the resolved config is the
  reviewer's private business, so re-pointing a named tier at a different model or
  provider does not invalidate a verdict.
- **\`max_prompt_chars\`** — a gate, not an input; lowering it can trip the gate on
  an already-verified pair without invalidating the verdict. An LLM verdict
  records the SIZE of the prompt that produced it (\`promptChars\`), which is
  likewise not hashed: it is a record of inputs the hash already covers, so a
  still-valid verdict's size is answered from the lock instead of by resolving
  companions and re-assembling the prompt just to count it. The tier's limit is
  still read live, so lowering a ceiling re-gates verdicts that are otherwise
  untouched. An entry written before this field existed simply has none and is
  measured the old way; the next \`yg check --approve\` records what it measured,
  costing no reviewer call.
- **\`when\` / \`implies\` / port declarations** — applicability is recomputed live
  each run and acts through the expected-pair set, not through invalidation.
- **CLI version / prompt scaffold** — upgrading Yggdrasil must not invalidate
  verdicts. The flip side is binding: the hash canonicalization is a frozen
  contract, changed only as a deliberate breaking decision.

Validity is checked by recomputing the hash from current inputs plus the stored
verdict token; a mismatch — whether from an input change or a hand-edited verdict
— renders the pair unverified. Tampering degrades to "needs review", never to
green. This is tamper *evidence* against casual edits, not cryptography; the trust
model is reviewing lock diffs in PRs and never hand-editing the lock.

## Relation conformance — computed live

The built-in relation-conformance check (\`yg knowledge read ports-and-relations\`)
is deterministic but NOT an aspect, and it is NOT stored in the lock at all. It is
recomputed **live on every \`yg check\`**: the pass parses each mapped source file,
resolves every statically-resolvable cross-node dependency, and verifies it
against the node's declared relations — every run, from scratch. There is no
cached relation verdict, no fingerprint, and nothing to migrate. The result is
always the current truth.

This differs from aspect verdicts in two ways:

- **No caching, no \`--approve\` gate.** Aspect pairs are filled by
  \`yg check --approve\` and cached; plain \`yg check\` re-validates them parse-free
  by re-hashing. Relation conformance does the full parse + resolve + verify on
  every \`yg check\` (plain or \`--approve\`) — it never reads or writes a lock entry,
  so it is never stale and never needs re-validation.
- **No status, no waiver.** A relation refusal (\`relation-undeclared-dependency\`)
  is always an error and blocks \`yg check\`. There is no \`content.md\` to sharpen
  and it is not \`yg-suppress\`-able. The only exits are **declare the relation**
  (add an architecture-allowed relation edge) or **remove the dependency**. The
  next run recomputes and the refusal clears the moment the code or graph matches.

## Caching policy

- **Both verdicts are cached, for both kinds.** A \`refused\` entry for unchanged
  inputs is FINAL — re-running \`yg check --approve\` does NOT re-verify it (for a
  deterministic pair a re-run is pointless; for an LLM pair it would be a
  re-roll). The three exits from a refusal:
  1. **Fix the code** — changes a subject file, invalidates the pair, re-verifies.
  2. **Sharpen the aspect's \`content.md\`** — changes the \`rule\` hash and
     re-verifies EVERY node using the aspect. Run \`yg impact --aspect <id>\` first.
  3. **\`yg-suppress\` with the user's approval** — a documented file-level waiver.

  There is deliberately no force / re-judge / verdict-drop command. Do NOT make a
  cosmetic edit to the aspect text or a source file purely to force an LLM
  re-roll — that is the same laundering the absent command refuses to offer.
- **Verdicts survive status flips**, including a \`draft\` round-trip: an entry for
  unchanged inputs stays valid when the aspect returns to enforced. To park an
  aspect, use \`status: draft\`, never a \`when\` edit — garbage-collection prunes
  when-excluded pairs but keeps draft pairs. Parking and unparking via draft buys
  no fresh look.
- **Fail-closed**: an entry is written only on a real verdict. Every infra
  disposition (provider unreachable, no reviewer configured, reference-load
  failure, unparseable response; for deterministic pairs a \`check.mjs\` import
  failure or thrown error; companion-assembly failure — hook throws, bad return
  shape, path outside allowed-reads, or missing path) writes nothing — the pair
  stays unverified. There is no "infra" verdict state.

## Garbage-collection

At the end of a successful \`yg check --approve\` run the lock is rewritten
canonically. Verdict entries whose pair is no longer in the pair universe (aspect
detached or deleted, file deleted or unmapped, \`scope\`/filter change, \`when\` now
false) are pruned, and \`nodes\` entries for node paths that no longer exist are
pruned. The pair universe for GC ignores status — **draft pairs keep their
entries**, which is what makes a draft round-trip free. Under
\`--only-deterministic\` the rewrite is scoped to the gitignored cache, so a
deterministic-only / CI run never rewrites (or GC-prunes) the committed files.

An entry is pruned only when it can be POSITIVELY proven detached — the retain
family covers every case where the graph cannot prove that this run: a node
whose own rule set could not be computed (e.g. an implies cycle, reported
separately), a file whose subject was unreadable this run, and a file the
type-level classifier could not decide a type for this run (reported
ambiguous). Every entry in that family keeps its stored result untouched.
\`--approve\` and \`--dry-run\` (a preview, computed over a disposable copy — it
writes nothing) both print a summary whenever something is actually pruned:
a count split into billed (LLM) vs free (deterministic), with the reason
listed per entry; nothing prints when nothing was pruned.

## Merge conflict in a committed lock file

Only the COMMITTED files can conflict (\`yg-lock.nondeterministic.json\`,
\`yg-lock.logs.json\`); the gitignored deterministic cache is never committed, so it
never conflicts. \`verdicts\` entries are self-validating, so resolution is trivial
and safe by construction:

1. Take ONE side wholesale of the conflicted file:
   \`git checkout --ours -- .yggdrasil/yg-lock.nondeterministic.json\` (or
   \`--theirs\`; or the \`.logs.json\` file). Prefer the side covering more of the
   merged code, to minimize re-verification.
2. Run \`yg check --approve\`. A wrongly kept line cannot lie — its hash will not
   match current inputs, so it re-verifies; the discarded side's verdicts are
   simply re-filled.

Do NOT hand-merge entry-by-entry even though entries are self-validating —
structural damage (duplicate keys, stray conflict markers) turns that file
\`lock-invalid\` (fail closed). \`lock-invalid\` detection recognizes \`<<<<<<<\`
conflict markers in either committed file and names the offending one.

When BOTH \`log.md\` files and a committed lock file conflicted, the order is:
resolve the lock file (take a side) → \`yg log merge-resolve --node <path>\` per
conflicted log → \`yg check --approve\`.

## Reverting a node

There is no per-node state file to check out, and the lock holds EVERY node's
verdicts. To roll a node back, revert its source and \`log.md\` via git and accept
one re-verification at the next \`yg check --approve\` (its pairs invalidate
because the subject files changed). NEVER check out the whole lock to roll back
one node — that clobbers every other node's verdicts. (Full revert recipe:
\`yg knowledge read log-management\`.)

## Lock format version

The current lock FORMAT version is 1 — exactly \`{ version, verdicts, nodes }\`.
There is no separate relation section and no migration to perform: relation
conformance is computed live (see above), so nothing about it ever lands in the
lock. The addition of \`companion.mjs\` support (including \`companionHash\` in the
inputHash and \`touched\` on companion-bearing LLM entries) does NOT bump the
format version — existing lock entries hash byte-identically when no
\`companion.mjs\` is present, and the format remains \`{ version: 1, verdicts,
nodes }\`.

A short history note: an unreleased alpha introduced a v2 lock that added a
\`relation_verdicts\` section for a cached relation check. That was reverted to v1.
For backward compatibility a committed v2 lock still loads cleanly — its stray
\`relation_verdicts\` section is simply dropped on read (it is moot now), and the
file is otherwise a valid v1 lock. The lock is rewritten with \`"version": 1\` on
the next \`yg check --approve\`.

## Absent or garbled lock

Each triad file is independently optional; an absent file contributes empty
state. So a fresh checkout (gitignored deterministic cache absent) reads its
deterministic pairs as unverified until \`yg check --approve --only-deterministic\`
rematerializes them. A garbled or unparseable file, or an unrecognized \`version\`
(neither 1 nor 2 — 2 is accepted only for the backward-compat drop above), is a
blocking \`lock-invalid\` error (fail closed) naming the offending file; for a
committed file the \`next:\` covers both recoveries (restore from git, or delete
and re-fill via \`yg check --approve\`); for the gitignored cache the recovery is
to delete it and re-run \`yg check --approve --only-deterministic\` (free).

## See also

- [[aspects-overview]] — reviewer kinds, scope, cost model
- [[aspect-status]] — severity-by-status, verdict reuse across flips
- [[log-management]] — the log gate, positive closure, revert recipe
- [[writing-deterministic-aspects]] — the observation surface
`;
