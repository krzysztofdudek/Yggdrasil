import { walk, report } from '@chrisdudek/yg/ast';

/**
 * runcheck-injected-input-parity
 *
 * core/check.ts's `runCheck(graph, gitTrackedFiles, options?)` gates SOME of
 * its checks on an optional field of `options`: when the field is absent,
 * runCheck silently SKIPS that check rather than erroring — the engine keeps
 * no clock and reads no files itself, so the caller must supply every input a
 * gated check needs. Every field written as:
 *
 *   const xIssues = options?.<KEY> ? <issues-producing expression> : [];
 *
 * is an ISSUE-GATING field (today: `nowUtc`, `rulesArtifacts`). A field that is
 * instead a side-effect switch (today: `writeFeatureIndex`, `now`) changes no
 * issue, so it is correctly excluded — but ONLY because it is named in the
 * SIDE_EFFECT_ONLY allowlist below.
 *
 * A gate is not the only way an injected input can move the issue set. A field
 * can instead be consumed as a WHOLE-LIST REWRITE of the assembled issues:
 *
 *   const issues = options?.<KEY> ? <fn>(<LIST>, options.<KEY>) : <LIST>;
 *   return { …, issues, … };
 *
 * That is an ISSUE-TRANSFORM field. It cannot be written in the gating shape —
 * its alternative is the untransformed list, never a literal `[]` — and it is
 * strictly MORE issue-affecting than a gate, since it may re-code, re-rank or
 * drop any issue rather than contribute a bounded set. So it is derived by its
 * own matcher (`deriveIssueTransformKeys`) and, exactly like a gating key, is
 * DEMANDED at every call site. That matcher requires the rewritten list to be
 * the one runCheck RETURNS as its issues, so a byproduct assembled in the same
 * shape — a report row, an index — is never mistaken for the issue set.
 *
 * ── The two things this rule enforces ────────────────────────────────────────
 *
 * 1. CLASSIFICATION (rule-completeness). Every OPTIONAL member of runCheck's
 *    options interface must be CLASSIFIED: matched by a gating construct in
 *    runCheck's own body, matched by the whole-list rewrite above, listed in
 *    SIDE_EFFECT_ONLY with a reason, or — for the window in which a field is
 *    declared and threaded before its consumer lands — named in ISSUE_TRANSFORM,
 *    which DEMANDS it at every call site and is honoured only while runCheck's
 *    body provably never reads it. A new optional member that is none of those
 *    is a loud violation demanding classification. This is what makes the rule
 *    self-updating for ANY shape a future gate is written in — an
 *    `if (options?.x) { issues.push(…) }` gate, or a ternary with a non-`[]`,
 *    non-list alternative, is matched by neither derivation below and would
 *    otherwise be silently under-enforced, exactly the failure this rule exists
 *    to eliminate. Instead the member surfaces as unclassified and a human must
 *    either teach a derivation its shape or classify it by hand.
 *
 * 2. PARITY (call-site completeness). Every `runCheck(...)` call in this node's
 *    own files must pass every issue-affecting key: every DERIVED gating key,
 *    every DERIVED whole-list-rewrite key, and every key ISSUE_TRANSFORM
 *    declares. Only SIDE_EFFECT_ONLY exempts a member from that demand — no
 *    classification added here can make the rule ask for LESS than it did.
 *
 * ── What is derived, and from where ─────────────────────────────────────────
 *
 * Everything except the node id and the two hand-signed maps is derived LIVE
 * from a single parse of core/check.ts (reached via this node's declared
 * `calls` relation to cli/core/check), so the verdict folds that file and
 * self-invalidates when it changes:
 *
 *   - the runCheck declaration itself (the derivation walk is scoped to ITS
 *     body — never the whole file, so an unrelated helper elsewhere in
 *     core/check.ts carrying its own `options?.x ? … : []` cannot inject a
 *     phantom required key);
 *   - the options parameter's NAME and POSITION (so the positional resolution
 *     of a call's options argument and the key set are derived from the SAME
 *     parse — a parameter reorder can never move one without the other);
 *   - the options interface NAME (from the parameter's type annotation) and its
 *     optional members;
 *   - the issue-gating key set;
 *   - the whole-list-rewrite key set;
 *   - which members runCheck's body reads at all, and whether the options object
 *     ever escapes a plain member access — the structural precondition that lets
 *     an ISSUE_TRANSFORM entry claim "declared, not yet consumed" and be checked
 *     on it rather than believed.
 *
 * ── errs: under ─────────────────────────────────────────────────────────────
 *
 * Both violation families fire only on provable facts.
 *
 * Both derivations aim at one thing: demand a key only where omitting it changes
 * the issue set runCheck returns — a gate's own bounded set silently disappears,
 * or the returned list is handed back unrewritten. A byproduct assembled in
 * either shape is not matched. The rewrite half reaches that by a name check
 * rather than a proof (see its KNOWN LIMIT below), so this is the rule's aim and
 * its ordinary behaviour, not a guarantee for every shape a body can take.
 *
 * PARITY: a call is flagged only when its options argument is a plain object
 * literal PROVABLY missing a key, or the options argument is absent entirely.
 * Anything that cannot be read statically — a variable or any other non-literal
 * options expression, a spread in the argument list or inside the object
 * literal, a computed key, a key shape this check does not recognize — is
 * treated as UNPROVABLE and silently skipped rather than reported. False
 * negatives are possible by design; false positives are not.
 *
 * CLASSIFICATION: "this optional member is matched by neither derivation and
 * named by neither map" is itself a provable fact about the parsed interface,
 * and an unclassified member IS what this rule forbids — so demanding
 * classification is not an over-approximation of the rule, it is the rule.
 *
 * ── Attribution ─────────────────────────────────────────────────────────────
 *
 * A rule-level failure (derivation blocked, or a member left unclassified) is
 * not a defect in any single line of the refused node's code — but it does mean
 * THIS node's runCheck call sites cannot be shown complete. So those diagnostics
 * are anchored at the node's OWN call sites, never at another node's file: a
 * refusal on `cli/core/fill` must not point the reader at `core/check.ts`, a
 * file that node does not own and cannot be held responsible for. (The runner
 * would accept core/check.ts as an anchor — the check touches it through the
 * declared relation — which is exactly why the restraint has to be deliberate.)
 * A node with no runCheck call at all yields one file-less, graph-level
 * diagnostic instead. Every message carries WHAT / WHY / NEXT.
 */

const CORE_CHECK_NODE_ID = 'cli/core/check';
const CORE_CHECK_FILE_SUFFIX = '/core/check.ts';
const RUNCHECK_FN_NAME = 'runCheck';
/** The property of runCheck's returned result that carries the issue set. */
const ISSUES_PROPERTY = 'issues';

/**
 * The EXEMPTING half of the classification: options members that exist to
 * flip a SIDE EFFECT and gate no issue. A member qualifies here only when
 * omitting it changes nothing about the ISSUE SET runCheck returns — it may
 * change what runCheck writes as a byproduct, or which clock a byproduct is
 * stamped with, but never which issues a caller sees. Anything that can add,
 * remove, or alter an issue belongs in the derived gating set instead, and a
 * caller omitting it is precisely the defect this rule catches.
 *
 * Keep this list SHORT and justified; an entry naming a member that no longer
 * exists, or one that a derivation now finds to be issue-affecting, is reported
 * as a stale or contradictory entry rather than silently trusted.
 */
const SIDE_EFFECT_ONLY = new Map([
  [
    'writeFeatureIndex',
    'writes the silent feature-field deviation index as a byproduct after the issue set is computed; never adds, removes, or alters an issue.',
  ],
  [
    'now',
    "supplies the clock stamped into that byproduct index's generatedAt; never reaches the issue set.",
  ],
  [
    'precomputedTypeCoverage',
    'supplies a type-coverage classification the caller already ran this run (e.g. runFill, before its own fill/GC steps); only decides whether runCheck classifies again or reuses it, never which issues appear — the classified result is identical either way for an unchanged file set.',
  ],
  [
    'precomputedRelationPass',
    'supplies an import-resolution pass the caller already ran this run (runFill, which needs the same edge index before its own structural gate); only decides whether runCheck parses every mapped source file again or reuses that result, never which issues appear. The pass reads SOURCE and a fill writes only lock and log files, so re-running it in the same process could only reproduce what was handed in.',
  ],
  [
    'precomputedVerification',
    'supplies a lock verification the caller already computed against the SAME lock bytes, for a caller that has written nothing since (only the --dry-run cost preview, which returns before the verdict writer exists). It decides whether every expected pair is re-hashed or the identical result is reused, never which issues appear — the classification is the same object either way. A caller that HAS written must not pass it, and the real fill path deliberately does not.',
  ],
  [
    'runtimeDispositions',
    "supplies the (file, aspectId, code) facts runFill's own fill just watched happen this run, translated here into CheckResult.typeVisibility.rows so its post-fill report can name the reason. typeVisibility is its own report field, never folded into the `unverified`/`aspect-violation-*` issue set: the pair this data describes was ALREADY unverified before this option existed (verifyLock decides that from the lock alone), and stays exactly as unverified with it present or absent — this option only changes how that same fact is WORDED in a separate field, never which issues appear or their count.",
  ],
]);

/**
 * The DEMANDING half of the classification, and the exact opposite of the map
 * above: options members that are ISSUE-AFFECTING as a whole-list rewrite and
 * are therefore REQUIRED at every runCheck call site.
 *
 * It exists for one narrow window. A whole-list rewrite arrives in two steps —
 * the field is declared on the options interface and threaded through every
 * call site first, and the code that consumes it lands after — so between those
 * two commits the member is real but `deriveIssueTransformKeys` has nothing in
 * runCheck's body to match. Without an entry here that member would read as
 * UNCLASSIFIED, and the only alternatives would be to lie about it in
 * SIDE_EFFECT_ONLY (a field that carries change scope is issue-altering by
 * definition — that entry would be false) or to leave the parity rule blocked.
 *
 * An entry here can only ever make this rule ask for MORE: its member joins the
 * required key set, so every call site must pass it. Nothing on this map is
 * exempted from anything. That is why it is safe in a way SIDE_EFFECT_ONLY is
 * not, and why a member wrongly placed here rather than derived still cannot
 * dodge a single call-site check.
 *
 * An entry is honoured ONLY while it is structurally true, and the sweep below
 * proves each of these against runCheck's own body rather than trusting the
 * text: the member must still be declared on the options interface; runCheck's
 * body must not read it (nor let the options object escape a plain member
 * access, which would put any read beyond this rule's sight); and neither
 * derivation may already classify it — a member the body gates on is a bounded
 * gate, not a whole-list rewrite, and the entry is then a false description that
 * is reported, not silently trusted. Once the consumer lands in the recognized
 * rewrite shape the derivation carries the member on its own and the entry is
 * redundant; keep this map SHORT and delete an entry as soon as it is.
 */
const ISSUE_TRANSFORM = new Map([
  [
    'changeScope',
    "carries which of this run's obligations the current change is accountable for, plus the name it was measured against. Scope decides which issues a run reports as blocking and which it re-codes as pre-existing, so it alters the issue set by definition and can never be side-effect-only. runCheck's body does not read it yet — the classification step that rewrites the assembled list with it lands separately — so it is demanded at every call site first, which is the whole point: a surface that had not been threaded before that step arrived would silently report a different issue set from every other.",
  ],
]);

/** tree-sitter counts `comment` as a NAMED child of argument lists, parameter
 *  lists, object literals and interface bodies. A comment is never a positional
 *  argument, a parameter, a property, or a member — dropping it here is what
 *  stops an inline comment from shifting positional resolution (and thereby
 *  silently disabling this rule at a call site). */
function withoutComments(nodes) {
  return nodes.filter((n) => n.type !== 'comment');
}

/** Locate the single `runCheck` function declaration in core/check.ts. Returns
 *  { decl } on success, or { error } when it is absent or ambiguous. */
function findRunCheckDeclaration(rootNode) {
  const found = [];
  walk(rootNode, (node) => {
    if (node.type !== 'function_declaration') return;
    if (node.childForFieldName('name')?.text === RUNCHECK_FN_NAME) found.push(node);
  });
  if (found.length === 0) {
    return { error: `no \`function ${RUNCHECK_FN_NAME}\` declaration was found in it` };
  }
  if (found.length > 1) {
    return {
      error: `${found.length} \`function ${RUNCHECK_FN_NAME}\` declarations were found in it, so this rule cannot tell which one the call sites reach`,
    };
  }
  return { decl: found[0] };
}

/**
 * Read the options parameter out of the runCheck declaration: its POSITION in
 * the parameter list, its NAME (what the gating conditions are written against)
 * and the NAME of its type (the interface whose members must be classified).
 * Deriving all three from the same parse is what keeps positional resolution
 * and key derivation coupled — the alternative, a hardcoded index 2, would go
 * silently wrong the moment runCheck's parameter order changed while the key
 * set kept self-updating.
 */
function findOptionsParameter(decl) {
  const params = decl.childForFieldName('parameters');
  if (!params) return { error: `its parameter list could not be read` };
  const list = withoutComments(params.namedChildren);
  const index = list.findIndex((p) => p.type === 'optional_parameter');
  if (index === -1) {
    return { error: `it declares no optional parameter, so there is no options argument to check call sites against` };
  }
  const param = list[index];
  const name = param.childForFieldName('pattern')?.text ?? param.childForFieldName('name')?.text;
  if (!name) return { error: `its optional parameter has no readable name` };
  const typeName = param.childForFieldName('type')?.namedChildren?.[0]?.text;
  if (!typeName) {
    return { error: `its optional parameter '${name}' carries no readable type name, so the options interface cannot be located` };
  }
  return { index, name, typeName };
}

/**
 * Scan the runCheck declaration's BODY (never the whole file) for
 * `<optionsName>?.<key> ? <issues> : []` ternaries.
 */
function deriveGatingKeys(decl, optionsName) {
  const keys = new Set();
  const body = decl.childForFieldName('body');
  if (!body) return keys;
  walk(body, (node) => {
    if (node.type !== 'ternary_expression') return;
    const condition = node.childForFieldName('condition');
    const alternative = node.childForFieldName('alternative');
    if (!condition || !alternative) return;
    // condition must be `<optionsName>?.<key>` — a member_expression with an
    // optional_chain field, whose object is the bare options identifier.
    if (condition.type !== 'member_expression') return;
    if (!condition.childForFieldName('optional_chain')) return;
    const object = condition.childForFieldName('object');
    if (!object || object.text !== optionsName) return;
    // alternative must be a literal empty array `[]`.
    if (alternative.type !== 'array' || alternative.namedChildren.length !== 0) return;
    const property = condition.childForFieldName('property');
    if (property) keys.add(property.text);
  });
  return keys;
}

/** True when `node` contains a read of `<optionsName>.<key>` (optionally chained). */
function readsOptionKey(node, optionsName, key) {
  let found = false;
  walk(node, (n) => {
    if (found) return false;
    if (n.type !== 'member_expression') return;
    if (n.childForFieldName('object')?.text !== optionsName) return;
    if (n.childForFieldName('property')?.text !== key) return;
    found = true;
    return false;
  });
  return found;
}

const FUNCTION_NODE_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'generator_function',
  'arrow_function',
  'method_definition',
]);

/** True when the nearest enclosing function of `node` is `decl` itself — so a
 *  nested helper's own `return` can never be read as runCheck's. */
function returnsFrom(node, decl) {
  for (let cur = node.parent; cur !== null; cur = cur.parent) {
    if (!FUNCTION_NODE_TYPES.has(cur.type)) continue;
    return cur.startIndex === decl.startIndex && cur.endIndex === decl.endIndex;
  }
  return false;
}

/**
 * The identifier(s) runCheck hands back AS ITS ISSUE SET: the name it returns
 * directly (`return issues;`), or the value of the `issues` property of a
 * returned object literal (`return { …, issues: allIssues, … };`, shorthand
 * included). Only `return`s belonging to runCheck itself count.
 *
 * This is what makes the whole-list-rewrite match a statement about THE ISSUE
 * SET rather than about any list that happens to sit inside this function. See
 * condition 5 below.
 */
function findReturnedIssueIdentifiers(decl) {
  const names = new Set();
  const body = decl.childForFieldName('body');
  if (!body) return names;
  walk(body, (node) => {
    if (node.type !== 'return_statement') return;
    if (!returnsFrom(node, decl)) return;
    const value = withoutComments(node.namedChildren)[0];
    if (!value) return;
    if (value.type === 'identifier') {
      names.add(value.text);
      return;
    }
    if (value.type !== 'object') return;
    for (const entry of withoutComments(value.namedChildren)) {
      if (entry.type === 'shorthand_property_identifier' && entry.text === ISSUES_PROPERTY) {
        names.add(ISSUES_PROPERTY);
        continue;
      }
      if (entry.type !== 'pair') continue;
      if (entry.childForFieldName('key')?.text !== ISSUES_PROPERTY) continue;
      const propertyValue = entry.childForFieldName('value');
      if (propertyValue?.type === 'identifier') names.add(propertyValue.text);
    }
  });
  return names;
}

/**
 * Whether this ternary's RESULT becomes the issue set runCheck returns: it is
 * bound to (or assigned to) one of `returnedNames`, or it IS the returned
 * expression / the `issues` property of the returned object literal.
 */
function becomesReturnedIssues(ternary, decl, returnedNames) {
  const parent = ternary.parent;
  if (!parent) return false;
  if (parent.type === 'variable_declarator' && parent.childForFieldName('value')?.startIndex === ternary.startIndex) {
    const name = parent.childForFieldName('name');
    return name?.type === 'identifier' && returnedNames.has(name.text);
  }
  if (parent.type === 'assignment_expression' && parent.childForFieldName('right')?.startIndex === ternary.startIndex) {
    const left = parent.childForFieldName('left');
    return left?.type === 'identifier' && returnedNames.has(left.text);
  }
  if (parent.type === 'return_statement') return returnsFrom(parent, decl);
  if (parent.type === 'pair' && parent.childForFieldName('key')?.text === ISSUES_PROPERTY) {
    const object = parent.parent;
    return object?.type === 'object' && object.parent?.type === 'return_statement' && returnsFrom(object.parent, decl);
  }
  return false;
}

/**
 * Scan the runCheck declaration's BODY (never the whole file, for the same
 * reason deriveGatingKeys does not) for a WHOLE-LIST REWRITE of the issue set:
 *
 *   const <ISSUES> = <optionsName>?.<key> ? <fn>(<LIST>, … <optionsName>.<key> …) : <LIST>;
 *
 * FIVE things must line up, and the match is deliberately no looser than the
 * gating one — a permissive "any ternary on an option" shape would let a field
 * that genuinely gates a bounded set be labelled a rewrite:
 *
 *   1. the condition is `<optionsName>?.<key>`, the same optional-chained member
 *      access on the bare options identifier the gating matcher requires. Of its
 *      three checks only the OBJECT one is load-bearing alone, and a fixture case
 *      pins it: without it a rewrite conditioned on some unrelated local carrying
 *      a same-named field derives that field's name as a key, and every call site
 *      is then refused for omitting an option whose presence changes nothing
 *      about that ternary — the rule inventing an obligation. The node-type check
 *      is subsumed by it (a non-member_expression has no `object` field, so the
 *      object check already rejects it) and no case pins it. The optional-chain
 *      check is NOT subsumed and is NOT pinned: deleting it would also match a
 *      plain `<optionsName>.<key>` condition, which is still this options object,
 *      so it widens the match without inventing a key. It stays for symmetry with
 *      the gating matcher, not because a case proves it;
 *   2. the alternative is a BARE IDENTIFIER — the untransformed list. (A literal
 *      `[]` alternative is the gating shape and is matched there instead; the
 *      two derivations therefore cannot both claim one construct.)
 *      SUBSUMED, kept deliberately: requirement 3 below compares the first
 *      argument's TEXT against the alternative's, and only an `identifier` node
 *      can be that argument, so the alternative can pass 3 only when its own text
 *      is a bare identifier — which is to say, only when it IS one. Deleting this
 *      line therefore cannot change any verdict, so no fixture case can pin it
 *      and none pretends to. It stays because it states the intent directly
 *      rather than leaving it as a consequence of how 3 happens to compare, and
 *      it keeps 3 free to become a structural comparison later without silently
 *      widening what shapes reach it;
 *   3. the consequence is a CALL whose FIRST argument is that same identifier,
 *      by name. This is what makes it a rewrite OF that list rather than an
 *      unrelated expression that merely happens to sit opposite it;
 *   4. the option's own value is handed to that call. A transform that never
 *      receives the option cannot be varying on it, and a call site omitting it
 *      would then change nothing — so demanding it everywhere would be noise;
 *   5. the RESULT becomes the issue set runCheck returns — bound or assigned to
 *      an identifier a `return` hands back, returned directly, or placed as the
 *      `issues` property of a returned object literal. Without this the match
 *      would say "some list in here is rewritten", not "the issue set is", and a
 *      side-effect option assembling a BYPRODUCT in this shape — a report row, an
 *      index — would be demanded at every call site though it alters no issue.
 *      That would be a FALSE POSITIVE, which `errs: under` forbids, and it would
 *      collide with that option's own side-effect classification and advise
 *      removing it.
 *
 * KNOWN LIMIT of requirement 5: it matches by NAME and does no scope analysis, so
 * a byproduct bound inside a nested block to a name that SHADOWS the returned
 * identifier still derives. That is far narrower than the hole it closed and it
 * errs toward demanding rather than exempting, but it means requirement 5 is a
 * name check and not a proof — do not describe this rule as demanding a key only
 * where omitting it provably changes the returned issue set.
 *
 * Narrowing in this direction is safe in a way widening would not be: a genuine
 * rewrite written so that its result reaches the return by some path this cannot
 * follow simply is not derived — and its member then falls to the CLASSIFICATION
 * half as UNCLASSIFIED, which is loud. A missed derivation degrades to "a human
 * must classify this", never to silence.
 */
function deriveIssueTransformKeys(decl, optionsName) {
  const keys = new Set();
  const body = decl.childForFieldName('body');
  if (!body) return keys;
  // Deliberately NO `if (returnedNames.size === 0) return` short-circuit. An
  // empty set is not "nothing is returned as issues" — it is "no return names an
  // IDENTIFIER", which is exactly the case for the two shapes that need no name
  // at all (`return <ternary>` and `return { issues: <ternary> }`). Bailing here
  // made both of those branches of becomesReturnedIssues unreachable on their
  // own, so a rewrite written in a shape this rule documents as recognized did
  // not derive, and the member's refusal then told its author to write the code
  // already in front of them.
  const returnedNames = findReturnedIssueIdentifiers(decl);
  walk(body, (node) => {
    if (node.type !== 'ternary_expression') return;
    const condition = node.childForFieldName('condition');
    const consequence = node.childForFieldName('consequence');
    const alternative = node.childForFieldName('alternative');
    if (!condition || !consequence || !alternative) return;
    // 1. condition is `<optionsName>?.<key>`.
    if (condition.type !== 'member_expression') return;
    if (!condition.childForFieldName('optional_chain')) return;
    if (condition.childForFieldName('object')?.text !== optionsName) return;
    const property = condition.childForFieldName('property');
    if (!property) return;
    // 2. alternative is the untransformed list, a bare identifier.
    if (alternative.type !== 'identifier') return;
    // 3. consequence is a call whose first argument is that same list.
    if (consequence.type !== 'call_expression') return;
    const args = consequence.childForFieldName('arguments');
    if (!args) return;
    const argList = withoutComments(args.namedChildren);
    if (argList.length === 0) return;
    if (argList[0].type !== 'identifier' || argList[0].text !== alternative.text) return;
    // 4. the option itself is fed to the transform.
    if (!argList.some((a) => readsOptionKey(a, optionsName, property.text))) return;
    // 5. the rewritten list is the one runCheck returns as its issues.
    if (!becomesReturnedIssues(node, decl, returnedNames)) return;
    keys.add(property.text);
  });
  return keys;
}

/**
 * Which option members runCheck's BODY reads, and whether the options object
 * ESCAPES — appears anywhere as something other than the object of a plain
 * member access (spread into a call, destructured, forwarded wholesale). An
 * escape means a member could be consumed out of this rule's sight, so the
 * "declared but provably unread" precondition an ISSUE_TRANSFORM entry rests on
 * can no longer be established for ANY member, and every such entry is reported
 * instead of believed. Returns `{ readKeys, escapes }`; a body that cannot be
 * read at all reports as escaping (fail closed).
 */
function collectOptionsReads(decl, optionsName) {
  const readKeys = new Set();
  const body = decl.childForFieldName('body');
  if (!body) return { readKeys, escapes: true };
  let escapes = false;
  walk(body, (node) => {
    if (node.type !== 'identifier' || node.text !== optionsName) return;
    const parent = node.parent;
    const asObject = parent?.type === 'member_expression' ? parent.childForFieldName('object') : null;
    if (!asObject || asObject.startIndex !== node.startIndex || asObject.endIndex !== node.endIndex) {
      escapes = true;
      return;
    }
    const property = parent.childForFieldName('property');
    // A computed access (`options[k]`) has no readable property name: which
    // member it reads is unknown, so treat it as an escape rather than as a
    // read of nothing.
    if (!property || property.type !== 'property_identifier') {
      escapes = true;
      return;
    }
    readKeys.add(property.text);
  });
  return { readKeys, escapes };
}

/**
 * Enumerate the options interface's own members. Returns
 * { optional: string[], malformed: string[] } — `malformed` collects member
 * shapes this check cannot name (an index/call signature, a non-identifier
 * member name), which are reported rather than ignored: an unreadable member is
 * an unclassifiable member.
 */
function findOptionsMembers(rootNode, typeName) {
  let body;
  walk(rootNode, (node) => {
    if (node.type !== 'interface_declaration') return;
    if (node.childForFieldName('name')?.text !== typeName) return;
    body = node.childForFieldName('body');
  });
  if (!body) return { error: `interface ${typeName} was not found in it` };

  const optional = [];
  const malformed = [];
  for (const member of withoutComments(body.namedChildren)) {
    if (member.type !== 'property_signature' && member.type !== 'method_signature') {
      malformed.push(`a ${member.type} (${JSON.stringify(member.text.slice(0, 60))})`);
      continue;
    }
    // The `?` optional marker is an ANONYMOUS child of the signature.
    let isOptional = false;
    for (let i = 0; i < member.childCount; i++) {
      if (member.child(i)?.type === '?') { isOptional = true; break; }
    }
    if (!isOptional) continue; // required members are enforced by the compiler
    const nameNode = member.childForFieldName('name');
    if (!nameNode || nameNode.type !== 'property_identifier') {
      malformed.push(`an optional member with a non-identifier name (${JSON.stringify(member.text.slice(0, 60))})`);
      continue;
    }
    optional.push(nameNode.text);
  }
  return { optional, malformed };
}

/**
 * Resolve the options argument of a runCheck call by the POSITION derived from
 * runCheck's own declaration. Comments are dropped first — tree-sitter counts
 * them as named children, so an inline comment among the arguments would
 * otherwise shift every later argument's position: a block comment written
 * between the first and second argument makes position 2 resolve to the SECOND
 * argument, a non-object, and the call is skipped in silence. A comment must
 * never be able to disable this rule at a call site.
 */
function optionsArgumentOf(callNode, optionsIndex) {
  const args = callNode.childForFieldName('arguments');
  if (!args) return { unprovable: true };
  const list = withoutComments(args.namedChildren);
  // A spread argument makes positional counting unprovable — bail rather
  // than risk a false positive.
  if (list.some((a) => a.type === 'spread_element')) return { unprovable: true };
  if (list.length <= optionsIndex) return { present: false };
  return { present: true, node: list[optionsIndex] };
}

/** Statically read one object-literal entry's key. Returns the key string, or
 *  undefined when the entry is UNPROVABLE (computed key, spread, or a shape
 *  this check does not recognize). Comments are filtered by the caller. */
function keyOfObjectEntry(entry) {
  if (entry.type === 'shorthand_property_identifier') return entry.text;
  if (entry.type === 'pair' || entry.type === 'method_definition') {
    // `pair` keys sit on the `key` field; `method_definition` (method shorthand,
    // `get`/`set`, `async`) names sit on the `name` field. Both are real, writable,
    // type-correct ways to supply a function-typed option.
    const key = entry.childForFieldName('key') ?? entry.childForFieldName('name');
    if (!key) return undefined;
    if (key.type === 'property_identifier') return key.text;
    if (key.type === 'number') return key.text;
    if (key.type === 'string') {
      // Only a plain, escape-free literal is provable; anything else is not.
      const inner = key.namedChildren.find((c) => c.type === 'string_fragment');
      if (key.namedChildren.some((c) => c.type === 'escape_sequence')) return undefined;
      return inner ? inner.text : '';
    }
    return undefined; // computed_property_name and anything else — UNPROVABLE
  }
  return undefined; // spread_element and any unrecognized entry — UNPROVABLE
}

/** Returns the set of statically-readable property keys of an object literal,
 *  or undefined when ANY entry is unprovable (spread, computed key, unknown
 *  shape) — an unprovable entry may carry the very key we would otherwise
 *  report as missing. */
function passedKeysOf(objectNode) {
  const keys = new Set();
  for (const entry of withoutComments(objectNode.namedChildren)) {
    const key = keyOfObjectEntry(entry);
    if (key === undefined) return undefined;
    keys.add(key);
  }
  return keys;
}

export function check(ctx) {
  const violations = [];

  // ── This node's own runCheck call sites ───────────────────────────────────
  // Collected FIRST: they are both the subject of the parity check and the
  // honest anchor for a rule-level failure (see "Attribution" above).
  const callSites = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'call_expression') return;
      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'identifier' || fn.text !== RUNCHECK_FN_NAME) return;
      callSites.push({ file, node });
    });
  }

  /** Emit a rule-level diagnostic against every own call site (or once,
   *  file-less, when this node has none). */
  const ruleLevel = (message) => {
    if (callSites.length === 0) {
      violations.push({ message });
      return;
    }
    for (const site of callSites) violations.push(report(site.file, site.node, message));
  };

  /** WHAT/WHY/NEXT wrapper for a diagnostic that blocks the derivation itself. */
  const derivationBlocked = (what, next) =>
    ruleLevel(
      `This ${RUNCHECK_FN_NAME}() call site cannot be verified: ${what} ` +
        `WHY: this rule proves a call site passes every issue-affecting option by deriving that option set live from ${CORE_CHECK_NODE_ID}'s core/check.ts. With the derivation blocked, no call site can be shown complete, and an omitted option makes ${RUNCHECK_FN_NAME} compute a different issue set — so this surface would report differently from another with no error anywhere. This is NOT a defect in this file's code; the fix is in the graph or in the rule. ` +
        `NEXT: ${next}`,
    );

  // Deliberately UNGUARDED: if this node's declared 'calls' relation to
  // cli/core/check is ever removed, ctx.graph.node throws
  // UndeclaredGraphReadError — the graph-aware runner (structure/runner.ts)
  // already converts that into a clean, actionable violation naming the
  // missing relation, so no local try/catch is needed here. (Under the
  // graphless AST runner used by `yg drill` / `yg aspect-test --files`, the
  // same access throws GraphAccessTrap, correctly reclassified upstream as
  // an 'unsupported' capability gap — swallowing it locally would instead
  // masquerade as a real refused/satisfied verdict, which is worse.)
  const checkNode = ctx.graph.node(CORE_CHECK_NODE_ID);
  if (!checkNode) {
    derivationBlocked(
      `node '${CORE_CHECK_NODE_ID}' is not present in the graph, so runCheck's issue-affecting options cannot be derived.`,
      `restore the node at .yggdrasil/model/${CORE_CHECK_NODE_ID}/yg-node.yaml, or — if core/check.ts genuinely moved to another node — update CORE_CHECK_NODE_ID in .yggdrasil/aspects/runcheck-injected-input-parity/check.mjs to the node that now owns it.`,
    );
    return violations;
  }
  const checkFile = checkNode.files.find((f) => f.path.endsWith(CORE_CHECK_FILE_SUFFIX));
  if (!checkFile) {
    derivationBlocked(
      `no file ending in '${CORE_CHECK_FILE_SUFFIX}' is mapped by node '${CORE_CHECK_NODE_ID}', so runCheck's issue-affecting options cannot be derived.`,
      `restore core/check.ts to the mapping in .yggdrasil/model/${CORE_CHECK_NODE_ID}/yg-node.yaml, or — if the file was renamed — update CORE_CHECK_FILE_SUFFIX in .yggdrasil/aspects/runcheck-injected-input-parity/check.mjs to match.`,
    );
    return violations;
  }

  const checkFileAst = ctx.parseAst(checkFile, 'typescript');
  const inCheckFile = `in ${checkFile.path}`;

  const declResult = findRunCheckDeclaration(checkFileAst.rootNode);
  if (declResult.error) {
    derivationBlocked(
      `${declResult.error} ${inCheckFile}.`,
      `if ${RUNCHECK_FN_NAME} was renamed or moved, update RUNCHECK_FN_NAME / CORE_CHECK_FILE_SUFFIX in .yggdrasil/aspects/runcheck-injected-input-parity/check.mjs; if it was removed entirely, retire this aspect and its attachments.`,
    );
    return violations;
  }
  const decl = declResult.decl;

  const optionsParam = findOptionsParameter(decl);
  if (optionsParam.error) {
    derivationBlocked(
      `${RUNCHECK_FN_NAME} was found ${inCheckFile}, but ${optionsParam.error}.`,
      `if ${RUNCHECK_FN_NAME} no longer takes an optional options argument, retire this aspect and its attachments; otherwise teach findOptionsParameter in .yggdrasil/aspects/runcheck-injected-input-parity/check.mjs the new signature shape.`,
    );
    return violations;
  }

  const gatingKeys = deriveGatingKeys(decl, optionsParam.name);
  const transformKeys = deriveIssueTransformKeys(decl, optionsParam.name);
  const { readKeys, escapes } = collectOptionsReads(decl, optionsParam.name);
  if (gatingKeys.size === 0 && transformKeys.size === 0) {
    derivationBlocked(
      `neither a '${optionsParam.name}?.<key> ? <issues> : []' issue-gating construct nor a '${optionsParam.name}?.<key> ? <fn>(<list>, ${optionsParam.name}.<key>) : <list>' whole-list rewrite was found in ${RUNCHECK_FN_NAME}'s body ${inCheckFile}, so the derived option set is EMPTY.`,
      `if ${RUNCHECK_FN_NAME} no longer varies its issue set on any injected option, retire this aspect and its attachments; if it still does but in a new shape, teach deriveGatingKeys / deriveIssueTransformKeys in .yggdrasil/aspects/runcheck-injected-input-parity/check.mjs that shape.`,
    );
    return violations;
  }

  // ── 1. CLASSIFICATION ─────────────────────────────────────────────────────
  // Every OPTIONAL member of the options interface must be accounted for: an
  // unclassified member may be a NEW gate written in a shape deriveGatingKeys
  // does not match, which would leave the rule silently under-enforcing.
  const members = findOptionsMembers(checkFileAst.rootNode, optionsParam.typeName);
  if (members.error) {
    derivationBlocked(
      `${members.error} ${inCheckFile}, so its optional members cannot be classified.`,
      `if the options type was renamed or is no longer an interface, teach findOptionsMembers in .yggdrasil/aspects/runcheck-injected-input-parity/check.mjs the new declaration shape.`,
    );
    return violations;
  }

  const RULE_PATH = '.yggdrasil/aspects/runcheck-injected-input-parity/check.mjs';
  const classificationNext = (member) =>
    `decide which '${member}' is and record it. If it GATES an issue, express it in ${RUNCHECK_FN_NAME}'s body as \`${optionsParam.name}?.${member} ? <issues> : []\`; if it REWRITES the whole issue list, express it as \`${optionsParam.name}?.${member} ? <fn>(<list>, ${optionsParam.name}.${member}) : <list>\` and let that result be what ${RUNCHECK_FN_NAME} returns as its \`${ISSUES_PROPERTY}\` — either shape derives automatically, and either way pass it at every ${RUNCHECK_FN_NAME} call site. If it is issue-affecting but its consumer has not landed yet, add it to ISSUE_TRANSFORM in ${RULE_PATH} with that reason, which demands it at every call site meanwhile. Only if it flips a SIDE EFFECT and can never add, remove, or alter an issue does it belong in SIDE_EFFECT_ONLY in that same file.`;

  for (const shape of members.malformed) {
    ruleLevel(
      `This ${RUNCHECK_FN_NAME}() call site cannot be shown complete: ${optionsParam.typeName} (${checkFile.path}) declares ${shape}, a member shape this rule cannot read or classify. ` +
        `WHY: an unreadable member may be a new issue-affecting input; if it is, omitting it here makes ${RUNCHECK_FN_NAME} compute a different issue set and this surface reports differently from another. This is NOT a defect in this file's code. ` +
        `NEXT: rewrite that member as a plain optional property, or teach findOptionsMembers in ${RULE_PATH} to read its shape.`,
    );
  }

  // ── 1a. The DEMANDING map's entries, proved against runCheck's own body ────
  // Each surviving entry joins the required key set below; each failing one is
  // reported rather than believed, exactly as a stale SIDE_EFFECT_ONLY entry is.
  const declaredTransformKeys = new Set();
  for (const [member] of ISSUE_TRANSFORM) {
    if (SIDE_EFFECT_ONLY.has(member)) {
      ruleLevel(
        `This ${RUNCHECK_FN_NAME}() call site rests on a contradictory classification: '${member}' is listed in BOTH ISSUE_TRANSFORM (issue-affecting, required at every call site) and SIDE_EFFECT_ONLY (gates no issue, exempt from every call site). ` +
          `WHY: those two claims cannot both be true, and while they disagree this rule cannot say whether a call site omitting '${member}' is complete or defective. This is NOT a defect in this file's code. ` +
          `NEXT: delete whichever entry is false in ${RULE_PATH} — a member that can alter the issue set belongs only in ISSUE_TRANSFORM.`,
      );
      continue;
    }
    if (gatingKeys.has(member)) {
      ruleLevel(
        `This ${RUNCHECK_FN_NAME}() call site rests on a superseded classification: ISSUE_TRANSFORM describes '${member}' as a whole-list rewrite, but ${RUNCHECK_FN_NAME}'s body gates a BOUNDED set of issues on it instead. ` +
          `WHY: the map is the half of this rule a human signs for, and an entry that no longer describes the code is an unreviewed claim; the derivation already carries this member, so the entry adds nothing but the disagreement. This is NOT a defect in this file's code. ` +
          `NEXT: remove '${member}' from ISSUE_TRANSFORM in ${RULE_PATH} — it derives as issue-gating on its own.`,
      );
      continue;
    }
    // The consumer landed in the recognized rewrite shape: the derivation owns
    // the member now and already demands it. The entry is redundant, not wrong.
    if (transformKeys.has(member)) continue;
    if (!members.optional.includes(member)) {
      ruleLevel(
        `This ${RUNCHECK_FN_NAME}() call site rests on a stale classification: ISSUE_TRANSFORM lists '${member}', but ${optionsParam.typeName} (${checkFile.path}) declares no such optional member. ` +
          `WHY: a stale entry demands an option nothing accepts, so every call site is judged against a key that cannot exist — and it silently pre-classifies any future member that happens to take that name. This is NOT a defect in this file's code. ` +
          `NEXT: remove '${member}' from ISSUE_TRANSFORM in ${RULE_PATH}, or restore the member it names.`,
      );
      continue;
    }
    if (escapes || readKeys.has(member)) {
      ruleLevel(
        `This ${RUNCHECK_FN_NAME}() call site rests on an unproven classification: ISSUE_TRANSFORM lists '${member}' as declared-but-not-yet-consumed, but ${RUNCHECK_FN_NAME}'s body ${escapes ? `uses '${optionsParam.name}' as more than a plain member access, so what it consumes cannot be read` : `already reads '${optionsParam.name}.${member}' in a shape neither derivation matches`}. ` +
          `WHY: that entry's only justification is that the body cannot yet act on the member; once it can, the shape it acts in is what decides whether every call site is being asked for enough, and an unrecognized shape is the silent under-enforcement this rule exists to prevent. This is NOT a defect in this file's code. ` +
          `NEXT: ${classificationNext(member)}`,
      );
      continue;
    }
    declaredTransformKeys.add(member);
  }

  // Every key a call site must pass. Gating and whole-list-rewrite keys are
  // derived from runCheck's own body; declared keys are the human-signed
  // additions proved above. SIDE_EFFECT_ONLY is the ONLY thing that exempts.
  const requiredKeys = new Set([...gatingKeys, ...transformKeys, ...declaredTransformKeys]);
  const sortedKeys = [...requiredKeys].sort();

  for (const member of members.optional) {
    const derived = gatingKeys.has(member) || transformKeys.has(member);
    const allowlisted = SIDE_EFFECT_ONLY.has(member);
    if (derived && allowlisted) {
      ruleLevel(
        `This ${RUNCHECK_FN_NAME}() call site rests on a contradictory classification: '${member}' is listed in SIDE_EFFECT_ONLY as altering no issue, but ${RUNCHECK_FN_NAME}'s body now ${gatingKeys.has(member) ? 'gates an issue on it' : 'rewrites the issue list it RETURNS with it'}. ` +
          `WHY: the allowlist is the half of this rule a human signs for; while it disagrees with the code, no call site's completeness can be trusted. This is NOT a defect in this file's code. ` +
          `NEXT: remove '${member}' from SIDE_EFFECT_ONLY in ${RULE_PATH} — it is issue-affecting and is already derived as such.`,
      );
      continue;
    }
    if (derived || allowlisted || ISSUE_TRANSFORM.has(member)) continue;
    ruleLevel(
      `This ${RUNCHECK_FN_NAME}() call site cannot be shown complete: ${optionsParam.typeName} (${checkFile.path}) declares an optional member '${member}' that is UNCLASSIFIED — ${RUNCHECK_FN_NAME}'s body neither gates issues on it nor rewrites its issue list with it, and neither of this rule's hand-signed maps names it. ` +
        `WHY: this rule can only prove a call site complete for options it knows about. An issue-affecting input written in a shape the derivations do not match would be silently ignored here, and a caller omitting it would make ${RUNCHECK_FN_NAME} report a different issue set with no error anywhere — the exact defect this rule exists to prevent. This is NOT a defect in this file's code. ` +
        `NEXT: ${classificationNext(member)}`,
    );
  }

  for (const [member] of SIDE_EFFECT_ONLY) {
    if (members.optional.includes(member) || gatingKeys.has(member) || transformKeys.has(member)) continue;
    ruleLevel(
      `This ${RUNCHECK_FN_NAME}() call site rests on a stale classification: SIDE_EFFECT_ONLY lists '${member}', but ${optionsParam.typeName} (${checkFile.path}) declares no such optional member. ` +
        `WHY: a stale allowlist entry is an unreviewed exemption — it silently pre-approves any future member that happens to take that name. This is NOT a defect in this file's code. ` +
        `NEXT: remove '${member}' from SIDE_EFFECT_ONLY in ${RULE_PATH}, or restore the member it names.`,
    );
  }

  // ── 2. PARITY ─────────────────────────────────────────────────────────────
  for (const { file, node } of callSites) {
    const opt = optionsArgumentOf(node, optionsParam.index);
    if (opt.unprovable) continue;

    if (!opt.present) {
      violations.push(
        report(
          file,
          node,
          `${RUNCHECK_FN_NAME}() call passes no options argument — missing issue-affecting option(s): ${sortedKeys.join(', ')}. Without them ${RUNCHECK_FN_NAME} computes a different issue set than a call site that supplies them — a gating option's check is silently skipped, and a whole-list option's rewrite silently does not happen. Pass ${sortedKeys.join(', ')} through, mirroring the other ${RUNCHECK_FN_NAME} call sites.`,
        ),
      );
      continue;
    }
    if (opt.node.type !== 'object') continue; // non-literal — cannot statically prove, skip

    const passedKeys = passedKeysOf(opt.node);
    if (!passedKeys) continue; // spread / computed key / unknown shape — cannot prove, skip

    const missing = sortedKeys.filter((k) => !passedKeys.has(k));
    if (missing.length > 0) {
      violations.push(
        report(
          file,
          node,
          `${RUNCHECK_FN_NAME}() call is missing issue-affecting option(s): ${missing.join(', ')}. Without them ${RUNCHECK_FN_NAME} computes a different issue set than a call site that supplies them — a gating option's check is silently skipped, and a whole-list option's rewrite silently does not happen. Pass ${missing.join(', ')} through, mirroring the other ${RUNCHECK_FN_NAME} call sites.`,
        ),
      );
    }
  }

  return violations;
}
