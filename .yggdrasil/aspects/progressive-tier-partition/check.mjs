import { walk, report, inFile } from '@chrisdudek/yg/ast';

// This aspect exists purely to guard core/check-codes.ts — the module that
// declares SCOPED_CODES, the set progressive mode is ever allowed to consider
// downgrading from a blocking error to a non-blocking warning. Its own doc
// comment states the doctrine: "membership is doctrine, not convenience...
// a code stays out by default." This check is the mechanical half of that
// doctrine — it refuses the four ways the declaration can quietly drift:
//
//   (A) a STRUCTURAL_CODES member enters SCOPED_CODES without being one of
//       the array's own documented carve-outs (the trailing run introduced
//       by the "// Carve-outs from STRUCTURAL_CODES ..." comment);
//   (B) SCOPED_CODES overlaps APPROVE_GATING_CODES — a fill-abort reason can
//       never be a downgrade candidate;
//   (C) OUTSIDE_CODES is hand-listed as a literal array rather than derived
//       from SCOPED_CODES via outsideTwin;
//   (D) the '-outside' suffix is spelled a second time anywhere outside
//       outsideTwin() — the file's own sanctioned single spelling site.
//
// Every fact this check relies on (the carve-out set, the two code sets, the
// derivation shape, the sanctioned suffix site) is read live off the file's
// own AST — nothing here is a hand-copied twin of what check-codes.ts says,
// which would itself be exactly the kind of drift this rule exists to catch.
// A declaration this check cannot confidently locate by its known shape is
// SKIPPED, never guessed at: a false silence is acceptable (errs: under,
// see yg-aspect.yaml), a false refusal is not.

const TARGET_GLOB = '**/core/check-codes.ts';

// --- locating declarations by name -----------------------------------------

/**
 * Finds a top-level `export const <name> = ...` or `export function <name>`
 * declaration by name. Returns the `variable_declarator` (for a const) or the
 * `function_declaration` node (for a function); null if no such export exists.
 */
function findExportedDeclaration(root, name) {
  for (const stmt of root.namedChildren) {
    if (stmt.type !== 'export_statement') continue;
    const decl = stmt.childForFieldName('declaration');
    if (!decl) continue;
    if (decl.type === 'function_declaration') {
      if (decl.childForFieldName('name')?.text === name) return decl;
      continue;
    }
    if (decl.type !== 'lexical_declaration') continue;
    for (const d of decl.namedChildren) {
      if (d.type === 'variable_declarator' && d.childForFieldName('name')?.text === name) {
        return d;
      }
    }
  }
  return null;
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
 * Codes documented as carve-outs: string entries in the array's trailing run
 * introduced by a comment mentioning "carve-out" — the file's own marker for
 * "structural, but admitted into SCOPED_CODES for a stated reason". A comment
 * (any comment) resets the run, so only entries between a carve-out marker
 * and the next comment (or the array's end) count as documented — matching
 * how STRUCTURAL_CODES groups every other bucket in the same array.
 */
function carveOutDocumentedCodes(arrayNode) {
  const documented = new Set();
  let inCarveOutRun = false;
  for (const child of arrayNode.namedChildren) {
    if (child.type === 'comment') {
      inCarveOutRun = /carve-?out/i.test(child.text);
      continue;
    }
    if (child.type !== 'string' || !inCarveOutRun) continue;
    const frag = child.namedChildren.find((c) => c.type === 'string_fragment');
    if (frag) documented.add(frag.text);
  }
  return documented;
}

// --- the four checks ---------------------------------------------------

/** (A) A STRUCTURAL_CODES member of SCOPED_CODES must be one of the array's
 *  own documented carve-outs. */
function checkCarveOutFidelity(file, scopedArray, structuralArray, violations) {
  const structuralCodes = new Set(stringEntries(structuralArray).map((e) => e.code));
  const documented = carveOutDocumentedCodes(scopedArray);
  for (const { code, node } of stringEntries(scopedArray)) {
    if (structuralCodes.has(code) && !documented.has(code)) {
      violations.push(
        report(
          file,
          node,
          `SCOPED_CODES admits '${code}', a STRUCTURAL_CODES member, without a documented carve-out — every structural code entering the downgrade-eligible set must be one of the file's named, documented carve-outs.`,
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

    const structuralDecl = findExportedDeclaration(root, 'STRUCTURAL_CODES');
    const scopedDecl = findExportedDeclaration(root, 'SCOPED_CODES');
    const gatingDecl = findExportedDeclaration(root, 'APPROVE_GATING_CODES');
    const outsideDecl = findExportedDeclaration(root, 'OUTSIDE_CODES');
    const outsideTwinDecl = findExportedDeclaration(root, 'outsideTwin');

    const structuralArray = structuralDecl && setLiteralArray(structuralDecl);
    const scopedArray = scopedDecl && setLiteralArray(scopedDecl);
    const gatingArray = gatingDecl && setLiteralArray(gatingDecl);

    if (structuralArray && scopedArray) {
      checkCarveOutFidelity(file, scopedArray, structuralArray, violations);
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
