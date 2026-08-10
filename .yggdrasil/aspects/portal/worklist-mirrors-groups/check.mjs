import { walk, report } from '@chrisdudek/yg/ast';

/**
 * portal/worklist-mirrors-groups
 *
 * The portal worklist (`WorklistGroup`, portal/contract.ts) is a HAND-MAINTAINED view of
 * the CLI's own issue-grouping shape (`IssueGroup`, cli/group-issues.ts) — the two are
 * separate interfaces, so nothing in the compiler stops one from gaining a field the
 * other never learns about. That is exactly the defect this rule exists to catch: a
 * command-line grouping refinement (a new `IssueGroup` field) can silently never reach
 * the web worklist, because `toGroup()` (portal/derive-rest.ts) — the one place that
 * actually copies `IssueGroup` into `WorklistGroup` — is hand-written too, and nothing
 * forced it to keep up. This check makes that drift a build failure instead of a stale
 * screen a human happens to notice two releases later.
 *
 * MIRROR exhaustiveness is checked in BOTH directions (see the two loops after the
 * per-pin comparison below): every `IssueGroup` field must be either pinned or
 * explicitly recorded as CLI-only (`CLI_ONLY`), and every pinned `IssueGroup` field name
 * must still exist for real (a pin naming a renamed/removed field is a DEAD pin, refused
 * on its own). This also catches a "consistent rename" on both sides: the old field's
 * dead pin fires even when a same-named new field on both sides would otherwise look
 * fine.
 *
 * `findInterface` unions members across every same-named `interface IssueGroup { ... }`
 * declaration in the file rather than reading only the first one it finds. TypeScript's
 * declaration-merging rule treats two `interface X { ... }` blocks sharing a name in one
 * file as ONE logical type (the compiler unions their members); reading only the first
 * block would make a field declared solely in a later block look ABSENT, producing a
 * spurious DEAD-PIN refusal for a field that is genuinely present and genuinely mirrored
 * — with a NEXT that, if followed, would tell a maintainer to delete a live pin and drop
 * a field WorklistGroup still needs. See `findInterface`'s own doc comment.
 *
 * The aspect runs `errs: over`, not `under`: the heritage guard below refuses a state
 * that is not provably wrong, which `under` does not permit — see that guard's own
 * comment.
 *
 * COVERAGE NOTE: `CLI_ONLY`'s two branches (the exemption skip in the forward-
 * exhaustiveness loop, and its own liveness loop, both below) have NO drill-corpus
 * coverage and cannot get any — a case file supplies interface text, not a way to inject
 * an entry into a `Map` literal that lives in this source file. Restructuring `CLI_ONLY`
 * into something a case file COULD drive (e.g. reading it from a mapped data file) was
 * considered and rejected: it would turn a small, rarely-touched, reviewed-by-diff
 * allowlist (empty today, exactly like the precedent `SIDE_EFFECT_ONLY` in
 * runcheck-injected-input-parity/check.mjs, which carries the same shape and the same
 * gap) into a second moving part with no offsetting benefit. Both branches are therefore
 * inspection-only, same as their precedent — verified by reading, not drilled. This is
 * not a free pass: `check.mjs`'s own file hash is a verdict input, so editing CLI_ONLY
 * invalidates the recorded verdict and the new state re-verifies on the next check.
 *
 * MIRROR below is the pinned contract: every `IssueGroup` field on the left has a named
 * `WorklistGroup` counterpart on the right, UNLESS it is listed in `CLI_ONLY` with a
 * reason. Both maps are AUTHORED, not derived — reviewed exactly like the two interfaces
 * they compare. A `WorklistGroup`/`WorklistMember` field with no `IssueGroup` counterpart
 * (the CLI adding LESS than the portal shows) is out of scope — this rule only catches
 * the CLI moving ahead of the portal, since that is the direction that shipped broken.
 *
 * `WorklistMember` (portal/contract.ts) is deliberately NOT covered by this rule, and the
 * aspect description does not claim it is: unlike `WorklistGroup`, it is not a
 * field-for-field mirror of a single source type — `toMember()` (portal/derive-rest.ts)
 * builds each member from `CheckIssue` under several group-level CONDITIONS (a field is
 * populated only when the group diverges, or only for `FULL_WHAT_CODES`, etc.), so "every
 * source field has a pinned counterpart" is not even the right shape of rule for it. That
 * is a separate, larger rule to design later, not an extension of this one.
 *
 * ── Two run modes ──────────────────────────────────────────────────────────────────
 *
 * Real graph access — production `yg check --approve` / `yg fill`, and
 * `aspect-test --node` (both via structure/runner.ts): both interfaces are read through
 * this node's ALREADY-declared relations (`calls cli/group-issues`, `uses
 * cli/portal/contract` — both already on cli/portal/engine-api, so this aspect adds no
 * new relation) and parsed live, so the verdict folds both files and self-invalidates
 * the moment either one changes. Mirrors the precedent on this same node
 * (runcheck-injected-input-parity/check.mjs): reach the target node via `ctx.graph.node`,
 * find its file by suffix, then `ctx.parseAst` the FILE OBJECT (not a bare string path)
 * — the incantation that reuses the file the dispatcher already prewarmed instead of
 * triggering a second, redundant disk read.
 *
 * `yg drill` (ast/runner.ts, `graphAccessTrap: true` — `ctx.fs`/`graph`/`parseAst`/etc.
 * become getters that THROW the instant they are read): a drill case file carries copies
 * of BOTH interfaces, read from `ctx.files` instead.
 *
 * Mode is detected by CAPABILITY, not by guessing (e.g. never by counting ctx.files):
 * `hasGraphAccess()` actually reads `ctx.fs` inside a try/catch. Under the drill trap
 * that read throws immediately — confirmed empirically that even a bare `typeof ctx.fs`
 * triggers the getter and throws, so a naive `typeof ctx.fs !== 'undefined'` guard would
 * itself blow up under `yg drill` and get the whole case misreported as 'unsupported'.
 * The try/catch is what makes the probe safe in every mode: a live object (real graph),
 * `undefined` with no throw (an ad-hoc `aspect-test --files` run — no trap, no graph
 * either), or a throw (the drill trap) all resolve to the correct branch.
 */

const GROUP_ISSUES_NODE_ID = 'cli/group-issues';
const GROUP_ISSUES_FILE_SUFFIX = '/cli/group-issues.ts';
const CONTRACT_NODE_ID = 'cli/portal/contract';
const CONTRACT_FILE_SUFFIX = '/portal/contract.ts';

const ISSUE_GROUP_INTERFACE = 'IssueGroup';
const WORKLIST_GROUP_INTERFACE = 'WorklistGroup';

/** Pinned mirror: IssueGroup field -> WorklistGroup field. Authored, not derived — see
 *  the module doc comment above for why an unmatched entry here is the whole point. */
const MIRROR = [
  ['code', 'code'],
  ['aspectId', 'aspectId'],
  ['severity', 'severity'],
  ['label', 'rule'],
  ['pairCount', 'pairCount'],
  ['nodeCount', 'nodeCount'],
  ['fileCount', 'fileCount'],
  ['sharedWhy', 'why'],
  ['sharedNext', 'fix'],
  ['divergentWhy', 'divergentWhy'],
  ['divergentNext', 'divergentNext'],
  ['perMemberReason', 'perMemberReason'],
  ['members', 'members'],
];

/**
 * IssueGroup fields that are deliberately CLI-only — reviewed and recorded here with a
 * reason, exactly like MIRROR itself, instead of just being absent from MIRROR (which the
 * forward-exhaustiveness check below would otherwise (rightly) treat as an unreviewed
 * gap). Empty today: every current IssueGroup field is mirrored.
 */
const CLI_ONLY = new Map([
  // ['someField', 'reason this field is intentionally CLI-only and never reaches the portal'],
]);

/**
 * True when `interfaceNode` (an `interface_declaration`) carries a heritage clause
 * (`interface X extends Y`). Returns the extended type name(s) (their source text) for
 * the diagnostic, or undefined when there is no `extends`.
 */
function heritageNames(interfaceNode) {
  const clause = interfaceNode.namedChildren.find((c) => c.type === 'extends_type_clause');
  if (!clause) return undefined;
  return clause.childrenForFieldName('type').map((t) => t.text);
}

/**
 * Find every `interface <name> { ... }` declaration in `tree` and return their UNIONED
 * top-level property-signature field names, the FIRST declaration node (so a violation
 * can be anchored at a real interface, not a placeholder line), and the UNION of any
 * heritage (`extends`) type names across all of them. Returns undefined when `tree` has
 * no rootNode (unparseable / wrong language) or the interface is not declared in it at
 * all — note this also covers a rewrite to a `type` alias (`type X = {...}`), which is a
 * different node type (`type_alias_declaration`) this function does not match; that case
 * surfaces as a "could not locate" violation below, whose NEXT names it explicitly.
 *
 * Unioning across every same-named declaration is required for correctness, not just
 * generosity: TypeScript's own declaration-merging rule treats two `interface X { ... }`
 * blocks sharing a name in one file as ONE logical type (the compiler unions their
 * members) — reading only the first block would make a field declared solely in a later
 * block invisible to this check and produce a spurious DEAD-PIN refusal for a field that
 * is genuinely present and genuinely mirrored. Reading all declarations and unioning is
 * simply reading the shape correctly, matching what the language itself does — not a
 * guard bolted on afterward.
 */
function findInterface(tree, name) {
  if (!tree || !tree.rootNode) return undefined;
  const decls = [];
  walk(tree.rootNode, (n) => {
    if (n.type !== 'interface_declaration') return;
    const id = n.childForFieldName('name');
    if (id && id.text === name) decls.push(n);
  });
  if (decls.length === 0) return undefined;
  const fields = new Set();
  const heritage = [];
  for (const n of decls) {
    const body = n.childForFieldName('body');
    for (const c of body ? body.namedChildren : []) {
      if (c.type === 'property_signature') {
        const pn = c.childForFieldName('name');
        if (pn) fields.add(pn.text);
      }
    }
    const h = heritageNames(n);
    if (h) heritage.push(...h);
  }
  return { node: decls[0], fields, heritage: heritage.length > 0 ? heritage : undefined };
}

/**
 * True while `ctx` carries real graph access. Reading `ctx.fs` IS the capability probe —
 * wrapped in try/catch because under `yg drill`'s graphless trap the read throws on the
 * spot (see the module doc comment: even `typeof ctx.fs` triggers the getter), so the
 * catch — not a truthy check — is what correctly detects "no graph here."
 */
function hasGraphAccess(ctx) {
  try {
    return ctx.fs !== undefined && ctx.fs !== null;
  } catch {
    return false;
  }
}

/** One violation, anchored at `node` in `file` when both are known, else a graph-level
 *  (line 1 / column 0) diagnostic against whichever file is the best available anchor. */
function violation(file, node, message) {
  if (file && node) return report(file, node, message);
  return { file: file ? file.path : undefined, line: 1, column: 0, message };
}

export function check(ctx) {
  const violations = [];
  let issueGroup, worklistGroup, issueFile, worklistFile;

  if (hasGraphAccess(ctx)) {
    const groupIssuesNode = ctx.graph.node(GROUP_ISSUES_NODE_ID);
    const contractNode = ctx.graph.node(CONTRACT_NODE_ID);
    issueFile = groupIssuesNode?.files.find((f) => f.path.endsWith(GROUP_ISSUES_FILE_SUFFIX));
    worklistFile = contractNode?.files.find((f) => f.path.endsWith(CONTRACT_FILE_SUFFIX));
    if (issueFile) issueGroup = findInterface(ctx.parseAst(issueFile, 'typescript'), ISSUE_GROUP_INTERFACE);
    if (worklistFile) worklistGroup = findInterface(ctx.parseAst(worklistFile, 'typescript'), WORKLIST_GROUP_INTERFACE);
  } else {
    // Drill mode (or an ad-hoc `aspect-test --files` run): a case file carries copies of
    // BOTH interfaces. Scan every file in ctx.files rather than assuming a fixed name or
    // position — the corpus is free to put both in one file or split across two.
    for (const file of ctx.files) {
      if (!file.ast) continue;
      if (!issueGroup) {
        const found = findInterface(file.ast, ISSUE_GROUP_INTERFACE);
        if (found) { issueGroup = found; issueFile = file; }
      }
      if (!worklistGroup) {
        const found = findInterface(file.ast, WORKLIST_GROUP_INTERFACE);
        if (found) { worklistGroup = found; worklistFile = file; }
      }
    }
  }

  if (!issueGroup) {
    violations.push(violation(
      issueFile ?? worklistFile ?? ctx.files[0],
      undefined,
      `Could not locate 'interface ${ISSUE_GROUP_INTERFACE}' to compare against the portal worklist contract. ` +
        `WHY: this rule proves the portal worklist mirrors the CLI's own grouping shape by comparing ${ISSUE_GROUP_INTERFACE} and ${WORKLIST_GROUP_INTERFACE} directly; without ${ISSUE_GROUP_INTERFACE} there is nothing to compare from. ` +
        `NEXT: if ${ISSUE_GROUP_INTERFACE} was renamed or moved out of source/cli/src${GROUP_ISSUES_FILE_SUFFIX}, update GROUP_ISSUES_FILE_SUFFIX / ISSUE_GROUP_INTERFACE in .yggdrasil/aspects/portal/worklist-mirrors-groups/check.mjs to match; if it was rewritten as a 'type' alias instead of an 'interface', either revert to an interface declaration (this check reads interface_declaration nodes only) or teach findInterface in check.mjs to also match a type_alias_declaration with an object type literal; under yg drill, make sure the case file declares 'interface ${ISSUE_GROUP_INTERFACE}'.`,
    ));
  }
  if (!worklistGroup) {
    violations.push(violation(
      worklistFile ?? issueFile ?? ctx.files[0],
      undefined,
      `Could not locate 'interface ${WORKLIST_GROUP_INTERFACE}' to compare against the CLI's own grouping shape. ` +
        `WHY: this rule proves the portal worklist mirrors ${ISSUE_GROUP_INTERFACE} by comparing ${ISSUE_GROUP_INTERFACE} and ${WORKLIST_GROUP_INTERFACE} directly; without ${WORKLIST_GROUP_INTERFACE} there is nothing to compare it against. ` +
        `NEXT: if ${WORKLIST_GROUP_INTERFACE} was renamed or moved out of source/cli/src${CONTRACT_FILE_SUFFIX}, update CONTRACT_FILE_SUFFIX / WORKLIST_GROUP_INTERFACE in .yggdrasil/aspects/portal/worklist-mirrors-groups/check.mjs to match; if it was rewritten as a 'type' alias instead of an 'interface', either revert to an interface declaration (this check reads interface_declaration nodes only) or teach findInterface in check.mjs to also match a type_alias_declaration with an object type literal; under yg drill, make sure the case file declares 'interface ${WORKLIST_GROUP_INTERFACE}'.`,
    ));
  }
  if (!issueGroup || !worklistGroup) return violations;

  // ── Heritage guard (deliberate errs: over) ────────────────────────────────────────
  // Either interface extending another type hides real members from the own-property-only
  // read above (a field hoisted into a base interface is still present but invisible
  // here). Comparing field SETS while a member set may be incomplete is unprovable EITHER
  // way — the fields might all still be in sync, but this check cannot show that, so it
  // fails CLOSED: refuse rather than risk a false "in sync" as much as a false "missing".
  // This is a KNOWN, deliberate over-approximation (see errs: over in yg-aspect.yaml) —
  // unlike declaration merging (fixed above by reading correctly instead of guarding), an
  // interface whose members are genuinely split across a base type is not something this
  // check can safely resolve without risking a wrong verdict in the other direction, so no
  // attempt is made to make this case provable. A "cannot verify" refusal is the right,
  // honest behavior for an enforced rule here, not a bug to eliminate.
  const heritageParts = [];
  if (issueGroup.heritage) heritageParts.push(`${ISSUE_GROUP_INTERFACE} extends ${issueGroup.heritage.join(', ')}`);
  if (worklistGroup.heritage) heritageParts.push(`${WORKLIST_GROUP_INTERFACE} extends ${worklistGroup.heritage.join(', ')}`);
  if (heritageParts.length > 0) {
    const anchorFile = worklistGroup.heritage ? worklistFile : issueFile;
    const anchorNode = worklistGroup.heritage ? worklistGroup.node : issueGroup.node;
    violations.push(violation(
      anchorFile,
      anchorNode,
      `Cannot verify ${ISSUE_GROUP_INTERFACE} and ${WORKLIST_GROUP_INTERFACE} are field-for-field in sync: ${heritageParts.join('; ')}. ` +
        `WHY: this check reads only each interface's OWN property signatures, never inherited members — a field hoisted into a base interface is invisible to it either way (it could misname a present-but-inherited field as missing, or, if it tried to guess around that, wrongly call a genuinely-missing field present). This aspect is deliberately errs: over for exactly this case: it refuses rather than risk either wrong verdict, even though the fields may in fact be perfectly in sync. ` +
        `NEXT: inline the inherited field(s) back onto the interface directly, or teach findInterface / the comparison in .yggdrasil/aspects/portal/worklist-mirrors-groups/check.mjs to resolve members declared on a base interface in the same file.`,
    ));
    return violations;
  }

  // ── Per-pin comparison ─────────────────────────────────────────────────────────────
  // A pinned IssueGroup field with no live WorklistGroup counterpart.
  for (const [from, to] of MIRROR) {
    if (issueGroup.fields.has(from) && !worklistGroup.fields.has(to)) {
      violations.push(violation(
        worklistFile,
        worklistGroup.node,
        `${ISSUE_GROUP_INTERFACE}.${from} has no ${WORKLIST_GROUP_INTERFACE}.${to} counterpart — the portal worklist has drifted from the CLI's own grouping shape. ` +
          `WHY: WorklistGroup is a hand-maintained mirror of IssueGroup (see MIRROR in .yggdrasil/aspects/portal/worklist-mirrors-groups/check.mjs); nothing in the type system re-checks that mirror when IssueGroup gains or renames a field, so a command-line refinement can silently stop reaching the web worklist. ` +
          `NEXT: add '${to}' to WorklistGroup in source/cli/src/portal/contract.ts and populate it from '${from}' in toGroup() (source/cli/src/portal/derive-rest.ts), mirroring the other MIRROR pairs — or, if '${from}' is genuinely CLI-only and should never reach the portal, remove the ['${from}', '${to}'] pair from MIRROR with a reason.`,
      ));
    }
  }

  // ── (a) Forward exhaustiveness ─────────────────────────────────────────────────────
  // Every real IssueGroup field must be either pinned in MIRROR or explicitly recorded in
  // CLI_ONLY. An unpinned field is exactly the "CLI moved ahead, portal stood still"
  // drift this rule exists to catch — the defect the single-direction version of this
  // check could not see at all.
  // INSPECTION-ONLY: the `CLI_ONLY.has(field)` skip below has no drill-corpus coverage —
  // see the COVERAGE NOTE in this file's header doc comment for why, and why that is the
  // right call rather than a gap to silently carry.
  const mirrorFromFields = new Set(MIRROR.map(([from]) => from));
  for (const field of issueGroup.fields) {
    if (mirrorFromFields.has(field) || CLI_ONLY.has(field)) continue;
    violations.push(violation(
      issueFile,
      issueGroup.node,
      `${ISSUE_GROUP_INTERFACE}.${field} is not pinned to any ${WORKLIST_GROUP_INTERFACE} field, and is not recorded in CLI_ONLY as an intentional CLI-only field. ` +
        `WHY: this rule exists to catch the command line moving ahead of the portal — an unpinned field is invisible to it, exactly the gap that let the portal worklist silently fall behind the CLI's own grouping shape for two releases. ` +
        `NEXT: either add ['${field}', '<WorklistGroup field name>'] to MIRROR in .yggdrasil/aspects/portal/worklist-mirrors-groups/check.mjs and surface it on WorklistGroup (source/cli/src/portal/contract.ts) + toGroup() (source/cli/src/portal/derive-rest.ts); or, if '${field}' is genuinely CLI-only and should never reach the portal, add it to CLI_ONLY in check.mjs with a reason.`,
    ));
  }

  // ── (b) Pin liveness ───────────────────────────────────────────────────────────────
  // Every MIRROR left-hand entry must still name a real IssueGroup field. A pin naming a
  // field that no longer exists is DEAD — MIRROR is claiming coverage it no longer has.
  // This also catches a "consistent rename" (IssueGroup.x -> IssueGroup.y AND
  // WorklistGroup.x' -> WorklistGroup.y' with the pair otherwise looking fine): the
  // OLD pin dies here even though the per-pin loop above sees no forward drift.
  for (const [from, to] of MIRROR) {
    if (issueGroup.fields.has(from)) continue;
    violations.push(violation(
      issueFile,
      issueGroup.node,
      `MIRROR pins ${ISSUE_GROUP_INTERFACE}.${from} -> ${WORKLIST_GROUP_INTERFACE}.${to}, but ${ISSUE_GROUP_INTERFACE} no longer declares a field named '${from}' — the pin is dead and MIRROR is lying about what it mirrors. ` +
        `WHY: a stale pin can silently hide a rename or a removal: the check credits coverage for a field that is no longer there, while any replacement field goes unpinned and unchecked. ` +
        `NEXT: if '${from}' was renamed, update the MIRROR entry to its new name in .yggdrasil/aspects/portal/worklist-mirrors-groups/check.mjs (and rename '${to}' on WorklistGroup / toGroup() to match, if appropriate); if it was removed outright, delete the ['${from}', '${to}'] pair from MIRROR (and drop '${to}' from WorklistGroup if it is now unused).`,
    ));
  }

  // ── CLI_ONLY liveness + reason validation (symmetry with the dead-pin check above) ──
  // INSPECTION-ONLY: this whole loop, like the exemption skip in (a) above, has no
  // drill-corpus coverage — see the COVERAGE NOTE in this file's header doc comment.
  for (const [field, reason] of CLI_ONLY) {
    if (!issueGroup.fields.has(field)) {
      violations.push(violation(
        issueFile,
        issueGroup.node,
        `CLI_ONLY lists '${field}' as an intentional CLI-only ${ISSUE_GROUP_INTERFACE} field, but ${ISSUE_GROUP_INTERFACE} no longer declares a field named '${field}'. ` +
          `WHY: a stale CLI_ONLY entry is an unreviewed exemption that silently pre-approves any future field that happens to reuse that name. ` +
          `NEXT: remove '${field}' from CLI_ONLY in .yggdrasil/aspects/portal/worklist-mirrors-groups/check.mjs, or restore the field it names.`,
      ));
    }
    // Cheap, worth having: an exemption with no written justification is exactly the
    // "unreviewed gap" this map exists to prevent (mirrors MIRROR/SIDE_EFFECT_ONLY —
    // every entry in an allowlist like this one is reviewed exactly like the code it
    // exempts, and a reviewer needs something to review).
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      violations.push(violation(
        issueFile,
        issueGroup.node,
        `CLI_ONLY's entry for '${field}' has no written reason (or an empty one). ` +
          `WHY: an unjustified exemption is an unreviewed gap — the whole point of recording a field here instead of just leaving it unpinned is that a human signs off on WHY it never reaches the portal. ` +
          `NEXT: give the CLI_ONLY entry for '${field}' a non-empty reason string in .yggdrasil/aspects/portal/worklist-mirrors-groups/check.mjs.`,
      ));
    }
  }

  return violations;
}
