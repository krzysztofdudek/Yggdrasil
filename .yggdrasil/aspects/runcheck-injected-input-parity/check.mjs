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
 * ── The two things this rule enforces ────────────────────────────────────────
 *
 * 1. CLASSIFICATION (rule-completeness). Every OPTIONAL member of runCheck's
 *    options interface must be CLASSIFIED: either matched by a gating construct
 *    in runCheck's own body, or listed in SIDE_EFFECT_ONLY with a reason. A new
 *    optional member that is neither is a loud violation demanding
 *    classification. This is what makes the rule self-updating for ANY shape a
 *    future gate is written in — an `if (options?.x) { issues.push(…) }` gate,
 *    or a ternary with a non-`[]` alternative, is not matched by the derivation
 *    below and would otherwise be silently under-enforced, exactly the failure
 *    this rule exists to eliminate. Instead the member surfaces as unclassified
 *    and a human must either teach the derivation its shape or allowlist it.
 *
 * 2. PARITY (call-site completeness). Every `runCheck(...)` call in this node's
 *    own files must pass every DERIVED issue-gating key.
 *
 * ── What is derived, and from where ─────────────────────────────────────────
 *
 * Everything except the node id and the side-effect allowlist is derived LIVE
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
 *   - the issue-gating key set.
 *
 * ── errs: under ─────────────────────────────────────────────────────────────
 *
 * Both violation families fire only on provable facts.
 *
 * PARITY: a call is flagged only when its options argument is a plain object
 * literal PROVABLY missing a key, or the options argument is absent entirely.
 * Anything that cannot be read statically — a variable or any other non-literal
 * options expression, a spread in the argument list or inside the object
 * literal, a computed key, a key shape this check does not recognize — is
 * treated as UNPROVABLE and silently skipped rather than reported. False
 * negatives are possible by design; false positives are not.
 *
 * CLASSIFICATION: "this optional member is neither derived-as-gating nor
 * allowlisted" is itself a provable fact about the parsed interface, and an
 * unclassified member IS what this rule forbids — so demanding classification
 * is not an over-approximation of the rule, it is the rule.
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

/**
 * The ONLY hardcoded half of the classification: options members that exist to
 * flip a SIDE EFFECT and gate no issue. A member qualifies here only when
 * omitting it changes nothing about the ISSUE SET runCheck returns — it may
 * change what runCheck writes as a byproduct, or which clock a byproduct is
 * stamped with, but never which issues a caller sees. Anything that can add,
 * remove, or alter an issue belongs in the derived gating set instead, and a
 * caller omitting it is precisely the defect this rule catches.
 *
 * Keep this list SHORT and justified; an entry naming a member that no longer
 * exists, or one that the derivation now finds to be issue-gating, is reported
 * as a stale entry rather than silently trusted.
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
        `WHY: this rule proves a call site passes every issue-gating option by deriving that option set live from ${CORE_CHECK_NODE_ID}'s core/check.ts. With the derivation blocked, no call site can be shown complete, and an omitted option makes ${RUNCHECK_FN_NAME} silently skip a check — so this surface would report fewer issues than another with no error anywhere. This is NOT a defect in this file's code; the fix is in the graph or in the rule. ` +
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
      `node '${CORE_CHECK_NODE_ID}' is not present in the graph, so runCheck's issue-gating options cannot be derived.`,
      `restore the node at .yggdrasil/model/${CORE_CHECK_NODE_ID}/yg-node.yaml, or — if core/check.ts genuinely moved to another node — update CORE_CHECK_NODE_ID in .yggdrasil/aspects/runcheck-injected-input-parity/check.mjs to the node that now owns it.`,
    );
    return violations;
  }
  const checkFile = checkNode.files.find((f) => f.path.endsWith(CORE_CHECK_FILE_SUFFIX));
  if (!checkFile) {
    derivationBlocked(
      `no file ending in '${CORE_CHECK_FILE_SUFFIX}' is mapped by node '${CORE_CHECK_NODE_ID}', so runCheck's issue-gating options cannot be derived.`,
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
  if (gatingKeys.size === 0) {
    derivationBlocked(
      `no '${optionsParam.name}?.<key> ? <issues> : []' issue-gating construct was found in ${RUNCHECK_FN_NAME}'s body ${inCheckFile}, so the issue-gating option set derives as EMPTY.`,
      `if ${RUNCHECK_FN_NAME} no longer gates any check on an injected option, retire this aspect and its attachments; if the gating is still there but written in a new shape, teach deriveGatingKeys in .yggdrasil/aspects/runcheck-injected-input-parity/check.mjs that shape.`,
    );
    return violations;
  }
  const sortedKeys = [...gatingKeys].sort();

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

  const classificationNext = (member) =>
    `decide which '${member}' is and record it. If it GATES an issue, express it in ${RUNCHECK_FN_NAME}'s body as \`${optionsParam.name}?.${member} ? <issues> : []\` so it derives automatically (and pass it at every ${RUNCHECK_FN_NAME} call site); if it only flips a SIDE EFFECT and can never add, remove, or alter an issue, add it to SIDE_EFFECT_ONLY in .yggdrasil/aspects/runcheck-injected-input-parity/check.mjs with that reason.`;

  for (const shape of members.malformed) {
    ruleLevel(
      `This ${RUNCHECK_FN_NAME}() call site cannot be shown complete: ${optionsParam.typeName} (${checkFile.path}) declares ${shape}, a member shape this rule cannot read or classify. ` +
        `WHY: an unreadable member may be a new issue-gating input; if it is, omitting it here makes ${RUNCHECK_FN_NAME} silently skip a check and this surface reports fewer issues than another. This is NOT a defect in this file's code. ` +
        `NEXT: rewrite that member as a plain optional property, or teach findOptionsMembers in .yggdrasil/aspects/runcheck-injected-input-parity/check.mjs to read its shape.`,
    );
  }

  for (const member of members.optional) {
    const gating = gatingKeys.has(member);
    const allowlisted = SIDE_EFFECT_ONLY.has(member);
    if (gating && allowlisted) {
      ruleLevel(
        `This ${RUNCHECK_FN_NAME}() call site rests on a contradictory classification: '${member}' is listed in SIDE_EFFECT_ONLY as gating no issue, but ${RUNCHECK_FN_NAME}'s body now gates an issue on it. ` +
          `WHY: the allowlist is the half of this rule a human signs for; while it disagrees with the code, no call site's completeness can be trusted. This is NOT a defect in this file's code. ` +
          `NEXT: remove '${member}' from SIDE_EFFECT_ONLY in .yggdrasil/aspects/runcheck-injected-input-parity/check.mjs — it is issue-gating and is already derived as such.`,
      );
      continue;
    }
    if (gating || allowlisted) continue;
    ruleLevel(
      `This ${RUNCHECK_FN_NAME}() call site cannot be shown complete: ${optionsParam.typeName} (${checkFile.path}) declares an optional member '${member}' that is UNCLASSIFIED — it is neither derived as issue-gating from ${RUNCHECK_FN_NAME}'s body nor listed in this rule's SIDE_EFFECT_ONLY allowlist. ` +
        `WHY: this rule can only prove a call site complete for options it knows about. An issue-gating input written in a shape the derivation does not match would be silently ignored here, and a caller omitting it would make ${RUNCHECK_FN_NAME} skip a check with no error anywhere — the exact defect this rule exists to prevent. This is NOT a defect in this file's code. ` +
        `NEXT: ${classificationNext(member)}`,
    );
  }

  for (const [member] of SIDE_EFFECT_ONLY) {
    if (members.optional.includes(member) || gatingKeys.has(member)) continue;
    ruleLevel(
      `This ${RUNCHECK_FN_NAME}() call site rests on a stale classification: SIDE_EFFECT_ONLY lists '${member}', but ${optionsParam.typeName} (${checkFile.path}) declares no such optional member. ` +
        `WHY: a stale allowlist entry is an unreviewed exemption — it silently pre-approves any future member that happens to take that name. This is NOT a defect in this file's code. ` +
        `NEXT: remove '${member}' from SIDE_EFFECT_ONLY in .yggdrasil/aspects/runcheck-injected-input-parity/check.mjs, or restore the member it names.`,
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
          `${RUNCHECK_FN_NAME}() call passes no options argument — missing issue-gating option(s): ${sortedKeys.join(', ')}. Without them ${RUNCHECK_FN_NAME} silently skips the corresponding check(s), so this call site reports fewer issues than a call site that supplies them. Pass ${sortedKeys.join(', ')} through, mirroring the other ${RUNCHECK_FN_NAME} call sites.`,
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
          `${RUNCHECK_FN_NAME}() call is missing issue-gating option(s): ${missing.join(', ')}. Without them ${RUNCHECK_FN_NAME} silently skips the corresponding check(s), so this call site reports fewer issues than a call site that supplies them. Pass ${missing.join(', ')} through, mirroring the other ${RUNCHECK_FN_NAME} call sites.`,
        ),
      );
    }
  }

  return violations;
}
