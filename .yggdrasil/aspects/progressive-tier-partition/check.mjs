import { walk, report, inFile } from '@chrisdudek/yg/ast';

// This aspect exists purely to guard core/check-codes.ts — the module that
// declares SCOPED_CODES, the set progressive mode is ever allowed to consider
// downgrading from a blocking error to a non-blocking warning. Its own doc
// comment states the doctrine: "membership is doctrine, not convenience...
// a code stays out by default." This check is the mechanical half of that
// doctrine for two specific, structurally-decidable collisions — it does NOT
// verify that every brand-new SCOPED_CODES addition carries a rationale (a
// wholly novel code that collides with neither STRUCTURAL_CODES nor
// APPROVE_GATING_CODES passes unchecked; see yg-aspect.yaml for the honest
// scope statement). What it refuses:
//
//   (A) a STRUCTURAL_CODES member enters SCOPED_CODES without ITS OWN named
//       rationale bullet in the doc comment directly above the SCOPED_CODES
//       declaration (the file's real doctrine: "Four codes are deliberate
//       carve-outs... - <code> — <reason>", one bullet per code). Checked
//       per CODE, not per proximity to a marker comment inside the array —
//       a bare code appended next to an already-documented one, with no
//       bullet of its own, is refused exactly like one with no nearby
//       comment at all;
//   (B) SCOPED_CODES overlaps APPROVE_GATING_CODES — a fill-abort reason can
//       never be a downgrade candidate;
//   (C) OUTSIDE_CODES is hand-listed as a literal array rather than derived
//       from SCOPED_CODES via outsideTwin;
//   (D) the '-outside' suffix is spelled a second time anywhere outside
//       outsideTwin() — the file's own sanctioned single spelling site.
//
// Every fact this check relies on (the per-code rationale bullets, the two
// code sets, the derivation shape, the sanctioned suffix site) is read live
// off the file's own AST — nothing here is a hand-copied twin of what
// check-codes.ts says, which would itself be exactly the kind of drift this
// rule exists to catch. A declaration this check cannot confidently locate
// by its known shape is SKIPPED, never guessed at: a false silence is
// acceptable (errs: under, see yg-aspect.yaml), a false refusal is not.

const TARGET_GLOB = '**/core/check-codes.ts';

// --- locating declarations by name -----------------------------------------

/**
 * Finds the top-level `export const <name> = ...` or `export function <name>`
 * statement by name. Returns `{ declNode, index }` — `declNode` is the
 * `variable_declarator` (for a const) or the `function_declaration` node (for
 * a function); `index` is its position among `root.namedChildren`, needed to
 * look up its own leading comment. Null if no such export exists.
 */
function findExportStatement(root, name) {
  const children = root.namedChildren;
  for (let i = 0; i < children.length; i++) {
    const stmt = children[i];
    if (stmt.type !== 'export_statement') continue;
    const decl = stmt.childForFieldName('declaration');
    if (!decl) continue;
    if (decl.type === 'function_declaration') {
      if (decl.childForFieldName('name')?.text === name) return { declNode: decl, index: i };
      continue;
    }
    if (decl.type !== 'lexical_declaration') continue;
    for (const d of decl.namedChildren) {
      if (d.type === 'variable_declarator' && d.childForFieldName('name')?.text === name) {
        return { declNode: d, index: i };
      }
    }
  }
  return null;
}

/** Convenience wrapper for callers that only need the declaration node. */
function findExportedDeclaration(root, name) {
  return findExportStatement(root, name)?.declNode ?? null;
}

/**
 * The comment node immediately preceding a top-level statement at `index` —
 * this file's convention for a declaration's own leading doc comment (see the
 * real `check-codes.ts`: the big `/** ... *\/` block sits directly above
 * `export const SCOPED_CODES`). Null if the preceding sibling isn't a comment.
 */
function leadingComment(root, index) {
  if (index <= 0) return null;
  const prev = root.namedChildren[index - 1];
  return prev?.type === 'comment' ? prev : null;
}

/**
 * Given a `const X = new Set<string>([...])` declarator, returns the array
 * literal node — or null if the value is not exactly that shape (a different
 * expression form is left unjudged by every check below, never assumed).
 */
function setLiteralArray(declaratorNode) {
  const valueNode = declaratorNode.childForFieldName('value');
  if (!valueNode || valueNode.type !== 'new_expression') return null;
  if (valueNode.childForFieldName('constructor')?.text !== 'Set') return null;
  const argsNode = valueNode.childForFieldName('arguments');
  return argsNode?.namedChildren.find((c) => c.type === 'array') ?? null;
}

/** Plain string-literal entries of an array literal, in source order. */
function stringEntries(arrayNode) {
  const entries = [];
  for (const child of arrayNode.namedChildren) {
    if (child.type !== 'string') continue;
    const frag = child.namedChildren.find((c) => c.type === 'string_fragment');
    if (frag) entries.push({ code: frag.text, node: child });
  }
  return entries;
}

/**
 * Codes with their OWN named rationale bullet in a doc comment, matching this
 * file's real doctrine shape: a bullet-list line reading `- <code> — <text>`
 * (the marker dash, a bare code token, then a dash separator before the
 * prose). Only the code token immediately after the bullet marker counts —
 * a continuation line of the same bullet's prose is indented further and
 * carries no leading "- ", so it never contributes a second, spurious code.
 * Deliberately NOT keyed on any specific English word (no "carve-out"
 * substring check): a prose rewording that keeps the "- code — reason" bullet
 * shape for the SAME code still matches, so a copyedit of the surrounding
 * sentence can never flip a genuinely-documented exception into a refusal.
 * A code with no comment at all, or one comment-adjacent only by array
 * position, gets no bullet match and is therefore NOT documented — position
 * inside the array plays no part in this determination.
 */
function ownRationaleBullets(commentNode) {
  const codes = new Set();
  if (!commentNode) return codes;
  const bulletLine = /^\s*\*?\s*-\s*([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\s*[—–-]\s/i;
  for (const line of commentNode.text.split('\n')) {
    const match = bulletLine.exec(line);
    if (match) codes.add(match[1]);
  }
  return codes;
}

// --- the four checks ---------------------------------------------------

/**
 * (A) A STRUCTURAL_CODES member of SCOPED_CODES must carry its own named
 * rationale bullet in the doc comment directly above the SCOPED_CODES
 * declaration — not merely sit near an in-array comment that documents a
 * DIFFERENT code. See yg-aspect.yaml: this check covers exactly this
 * collision (SCOPED_CODES ∩ STRUCTURAL_CODES), not general rationale
 * coverage for every SCOPED_CODES addition.
 */
function checkCarveOutFidelity(file, scopedArray, structuralArray, scopedDocComment, violations) {
  const structuralCodes = new Set(stringEntries(structuralArray).map((e) => e.code));
  const documented = ownRationaleBullets(scopedDocComment);
  for (const { code, node } of stringEntries(scopedArray)) {
    if (structuralCodes.has(code) && !documented.has(code)) {
      violations.push(
        report(
          file,
          node,
          `SCOPED_CODES admits '${code}', a STRUCTURAL_CODES member, with no rationale bullet of its own in the doc comment above the declaration — every structural code entering the downgrade-eligible set needs its own stated reason, not just placement near another carve-out's bullet.`,
        ),
      );
    }
  }
}

/** (B) SCOPED_CODES must never overlap APPROVE_GATING_CODES — a fill-abort
 *  reason can never be a downgrade candidate. */
function checkNoGatingOverlap(file, scopedArray, gatingArray, violations) {
  const gatingCodes = new Set(stringEntries(gatingArray).map((e) => e.code));
  for (const { code, node } of stringEntries(scopedArray)) {
    if (gatingCodes.has(code)) {
      violations.push(
        report(
          file,
          node,
          `'${code}' is a member of both SCOPED_CODES and APPROVE_GATING_CODES — a fill-abort reason can never be a downgrade candidate.`,
        ),
      );
    }
  }
}

/**
 * (C) OUTSIDE_CODES must be derived from SCOPED_CODES via outsideTwin, not a
 * hand-listed array of strings — a hand-listed twin can drift from
 * SCOPED_CODES silently the next time only one of them is edited. Flags ONLY
 * the unambiguous hand-listed shape (a literal array containing string
 * elements passed straight to `new Set(...)`); any other expression form
 * (a call, a spread, an identifier) is left unjudged rather than guessed at.
 */
function checkOutsideCodesDerived(file, outsideDecl, violations) {
  const valueNode = outsideDecl.childForFieldName('value');
  if (!valueNode || valueNode.type !== 'new_expression') return;
  if (valueNode.childForFieldName('constructor')?.text !== 'Set') return;
  const argsNode = valueNode.childForFieldName('arguments');
  const arrayNode = argsNode?.namedChildren.find((c) => c.type === 'array');
  if (!arrayNode) return; // not a literal array argument — nothing provably hand-listed
  const hasStringEntries = arrayNode.namedChildren.some((c) => c.type === 'string');
  if (!hasStringEntries) return;
  violations.push(
    report(
      file,
      outsideDecl,
      'OUTSIDE_CODES is a hand-listed array of codes, not one derived from SCOPED_CODES — derive it with `Array.from(SCOPED_CODES, outsideTwin)` so the two sets can never drift apart.',
    ),
  );
}

/**
 * (D) The '-outside' suffix must be spelled in exactly one place: inside
 * outsideTwin(). Any other string/template-literal fragment in the file that
 * spells it out is a second, driftable spelling of the same suffix — the
 * doc comment on outsideTwin calls it "the ONLY place the `-outside` suffix
 * is spelled". Only string/template CONTENT is scanned (never comments), so
 * the doc comment's own prose mention of the suffix is never mistaken for a
 * second code spelling.
 */
function checkSingleSuffixSpelling(file, root, outsideTwinNode, violations) {
  const twinStart = outsideTwinNode.startIndex;
  const twinEnd = outsideTwinNode.endIndex;
  walk(root, (node) => {
    if (node.type !== 'string_fragment') return;
    if (!node.text.includes('-outside')) return;
    if (node.startIndex >= twinStart && node.endIndex <= twinEnd) return; // the sanctioned spelling
    violations.push(
      report(
        file,
        node,
        "Found a second spelling of the '-outside' suffix outside outsideTwin() — call outsideTwin(code) instead of re-spelling the suffix, or the two spellings can drift apart silently.",
      ),
    );
  });
}

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    if (!inFile(file, { glob: TARGET_GLOB })) continue;
    const root = file.ast.rootNode;

    const structuralFound = findExportStatement(root, 'STRUCTURAL_CODES');
    const scopedFound = findExportStatement(root, 'SCOPED_CODES');
    const gatingDecl = findExportedDeclaration(root, 'APPROVE_GATING_CODES');
    const outsideDecl = findExportedDeclaration(root, 'OUTSIDE_CODES');
    const outsideTwinDecl = findExportedDeclaration(root, 'outsideTwin');

    const structuralArray = structuralFound && setLiteralArray(structuralFound.declNode);
    const scopedArray = scopedFound && setLiteralArray(scopedFound.declNode);
    const gatingArray = gatingDecl && setLiteralArray(gatingDecl);

    if (structuralArray && scopedArray) {
      const scopedDocComment = leadingComment(root, scopedFound.index);
      checkCarveOutFidelity(file, scopedArray, structuralArray, scopedDocComment, violations);
    }
    if (scopedArray && gatingArray) {
      checkNoGatingOverlap(file, scopedArray, gatingArray, violations);
    }
    if (outsideDecl) {
      checkOutsideCodesDerived(file, outsideDecl, violations);
    }
    if (outsideTwinDecl) {
      checkSingleSuffixSpelling(file, root, outsideTwinDecl, violations);
    }
  }
  return violations;
}
