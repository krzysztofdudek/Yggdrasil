import { walk } from '@chrisdudek/yg/ast';

// Invariant 6 (half): every §3a navigable SURFACE has a Playwright + Chromium e2e covering it.
// The authoritative list of surfaces is the SURFACE_MANIFEST array exported from the suite's
// support/surfaces.ts (kept in lock-step with §3a A). Each spec declares which surfaces it
// covers via an exported `COVERS` string array — a stable marker. This check, per node:
//
//   1. parses SURFACE_MANIFEST from the mapped support/surfaces.ts (the source of truth);
//   2. for every spec's exported COVERS array, verifies the spec actually EXERCISES each
//      surface it claims — the spec body must contain the navigation/marker the surface is
//      reached by (a hash route, a key chord, or the surface's own DOM seam). A spec that
//      claims a surface its body never drives is REFUSED (a declaration with no navigation
//      behind it is exactly the hollow-COVERS defect this binds shut);
//   3. unions every spec's verified COVERS;
//   4. REFUSES if any manifest surface is covered by NO spec — a missing surface is the whole
//      point: adding a surface to the manifest without a covering spec blocks the build.
//
// It also refuses a COVERS id that is NOT in the manifest (a typo / stale id that silently
// covers nothing), and refuses if the manifest itself cannot be found (fail closed — never
// silently pass with an empty manifest). AST-based, scope per node: it reads the string-array
// literals from the syntax tree (an `export const X = ['a','b']`), never raw text, so a string
// that merely mentions a surface id elsewhere is not a false positive.
//
// WHAT A GREEN HERE MEANS — read it correctly. A green proves the coverage map has no holes
// AND that every claimed surface is bound to a real navigation marker its covering spec drives
// (COVERS can no longer outrun the spec body). It still does NOT execute a browser; the live
// proof that each surface renders/transitions correctly is the `npm run test:e2e:portal` run in
// repo-check.sh (real Chromium against the real emitted page) PLUS the e2e-public-surface aspect
// (the suite stays a black box over the shipped CLI). A green from THIS check means the coverage
// map has no holes and no claim is hollow; it is not a substitute for the live run.

/** Pull the literal value out of a tree-sitter string / no-substitution template_string node. */
function stringValue(node) {
  if (!node) return undefined;
  if (node.type !== 'string' && node.type !== 'template_string') return undefined;
  if (node.type === 'template_string' && node.namedChildren.some((c) => c.type === 'template_substitution')) {
    return undefined;
  }
  const frag = node.namedChildren.find((c) => c.type === 'string_fragment');
  if (frag) return frag.text;
  const t = node.text;
  return t.length >= 2 ? t.slice(1, -1) : '';
}

/**
 * Find `export const <name> = [ ...string literals ]` (or `export const <name> = [...] as const`)
 * at the top level of a file's AST and return the array's string values. Returns null when the
 * named export is absent, or [] when it is present but empty. The array may appear directly as the
 * declarator value or wrapped in an `as const` assertion expression.
 */
function readExportedStringArray(rootNode, name) {
  let found = null;
  walk(rootNode, (node) => {
    if (node.type !== 'export_statement') return true;
    walk(node, (inner) => {
      if (inner.type !== 'variable_declarator') return true;
      const nameNode = inner.childForFieldName('name');
      if (!nameNode || nameNode.text !== name) return true;
      let valueNode = inner.childForFieldName('value');
      // Unwrap `[...] as const` / `[...] satisfies T` (TS assertion wrappers around the array).
      if (valueNode && (valueNode.type === 'as_expression' || valueNode.type === 'satisfies_expression')) {
        valueNode = valueNode.namedChildren[0];
      }
      if (!valueNode || valueNode.type !== 'array') return true;
      const values = [];
      for (const child of valueNode.namedChildren) {
        const v = stringValue(child);
        if (typeof v === 'string') values.push(v);
      }
      found = values;
      return false;
    });
    return true;
  });
  return found;
}

function isSpec(filePath) {
  return /\.spec\.ts$/.test(filePath);
}

function isSurfacesModule(filePath) {
  return /\/support\/surfaces\.ts$/.test(filePath) || /(^|\/)surfaces\.ts$/.test(filePath);
}

// ── The surface → navigation table ───────────────────────────────────────────────────────
//
// Each §3a manifest surface maps to the navigation markers a spec uses to actually DRIVE it: a
// hash route, a key chord, or the surface's own load-bearing DOM seam (the class/attribute the
// view/overlay/shell renders). A spec that claims a surface in COVERS must contain at least one
// of its markers — otherwise the claim is hollow (declared but never navigated to) and the spec
// is refused. Markers are deliberately navigation-bearing, NOT the bare surface id: many ids
// (e.g. `tree` → "Structure", `relations` → "Relations & boundaries") never appear verbatim, so
// matching the id text would let a spec that merely mentions the word pass. Each entry below is a
// regex source; the spec's full source text is tested against every alternative for the id.
//
// Keep an entry for EVERY id in SURFACE_MANIFEST — a manifest id with no table entry is itself a
// configuration hole and is reported (fail closed: an unknown id can never be "exercised").
const NAV_MARKERS = {
  // Full views V1–V9: reached by hash route, by the nav-rail label, or by the view's own seam.
  overview: ['#/view/overview', "navTo\\(page, 'Overview'\\)", '\\.ov-verdict', '\\.ov-residue', '\\.ov-precise'],
  coverage: ['#/view/coverage', "navTo\\(page, 'Coverage & audit'\\)", '\\.cov-ledger', '\\.cov-bar'],
  tree: ['#/view/tree', "navTo\\(page, 'Structure'\\)", '\\.tree-mount', '\\.tree-row'],
  relations: ['#/view/relations', "navTo\\(page, 'Relations & boundaries'\\)", '\\.mtx-canvas', '\\.mtx-mirror', '\\.rel-hub'],
  structure: ['#/view/structure', "navTo\\(page, 'Dependency structure'\\)", '\\.str-legend', '\\.str-tunnels', '\\.str-reach'],
  rulebook: ['#/view/rulebook', "navTo\\(page, 'Rulebook'\\)", '\\.rb-table'],
  types: ['#/view/types', "navTo\\(page, 'Type model'\\)", '\\.ty-grid', '\\.ty-card'],
  flows: ['#/view/flows', "navTo\\(page, 'Flows'\\)", '\\.fl-gallery', '\\.fl-detail'],
  suppressions: ['#/view/suppressions', "navTo\\(page, 'Suppressions'\\)", '\\.sup-table'],
  start: ['#/view/start', "navTo\\(page, 'Start here'\\)", '\\.st-card', '\\.st-steps'],
  // Persistent shell chrome.
  'shell-nav': ['\\.app-rail', '\\.rail-link'],
  'shell-panel': ['\\.app-panel', '#/node/', '\\.pan-path', '\\.pan-asprow'],
  'shell-refresh': ['\\.topbar-refresh'],
  'shell-approve': ['\\.topbar-approve'],
  'shell-theme': ['\\.topbar-theme', 'data-theme'],
  'shell-deeplink': ['page\\.reload', '#/node/', '#/view/'],
  'shell-prov': ['\\.pan-prov', '\\.pan-fresh'],
  // Overlays.
  'ov-palette': ['Meta\\+k', 'Control\\+k', '\\.rail-cmdk', '\\.palette-'],
  'ov-glossary': ['data-term', '\\.term\\['],
  'ov-approve': ['\\.topbar-approve', 'reviewer call', "page\\.on\\('dialog'"],
};

/**
 * Does the spec body actually exercise `surfaceId`? True iff its source text matches at least one
 * of the surface's navigation markers. `markers` is undefined for an id with no table entry —
 * the caller treats that as an unmappable claim (fail closed).
 */
function specDrives(specText, surfaceId) {
  const markers = NAV_MARKERS[surfaceId];
  if (!markers) return false;
  for (const m of markers) {
    if (new RegExp(m).test(specText)) return true;
  }
  return false;
}

export function check(ctx) {
  const violations = [];

  // 1. The authoritative manifest from support/surfaces.ts.
  let manifest = null;
  let manifestFile = null;
  for (const file of ctx.files) {
    if (!file.ast || !isSurfacesModule(file.path)) continue;
    const arr = readExportedStringArray(file.ast.rootNode, 'SURFACE_MANIFEST');
    if (arr) {
      manifest = arr;
      manifestFile = file.path;
      break;
    }
  }

  if (!manifest) {
    // Fail closed — a missing/empty manifest must never read as "everything covered".
    const first = ctx.files[0];
    violations.push({
      file: first ? first.path : undefined,
      line: 1,
      column: 0,
      message:
        `The §3a surface manifest (export const SURFACE_MANIFEST in support/surfaces.ts) could not be read ` +
        `from this suite's files. Every navigable surface's e2e coverage is keyed to it; without it nothing ` +
        `can be verified covered. Restore support/surfaces.ts with the SURFACE_MANIFEST string array.`,
    });
    return violations;
  }
  const manifestSet = new Set(manifest);

  // Fail closed on a manifest id the navigation table does not know — it can never be proven
  // exercised, so it must not silently read as coverable.
  for (const surface of manifest) {
    if (!Object.prototype.hasOwnProperty.call(NAV_MARKERS, surface)) {
      violations.push({
        file: manifestFile,
        line: 1,
        column: 0,
        message:
          `§3a surface '${surface}' is in the manifest but the every-surface-has-e2e navigation table has no ` +
          `markers for it, so a spec's COVERS claim for it cannot be bound to a real navigation. Add the ` +
          `surface's navigation markers (its hash route / key chord / DOM seam) to NAV_MARKERS in this check.`,
      });
    }
  }

  // 2. For every spec, union its COVERS — but only after verifying the spec BODY drives each
  //    surface it claims. A claimed surface with no matching navigation marker is a hollow
  //    declaration and is refused; it does NOT count toward coverage.
  const covered = new Set();
  const coverers = new Map(); // surfaceId -> [spec paths] (for the error message)
  for (const file of ctx.files) {
    if (!file.ast || !isSpec(file.path)) continue;
    const covers = readExportedStringArray(file.ast.rootNode, 'COVERS');
    if (!covers) {
      violations.push({
        file: file.path,
        line: 1,
        column: 0,
        message:
          `Portal e2e spec '${file.path}' does not export a COVERS string array. Every spec must declare ` +
          `which §3a surfaces it covers (export const COVERS = [...]) so coverage is mechanically verifiable ` +
          `against the surface manifest — even an empty COVERS = [] (a spec that only hardens existing surfaces).`,
      });
      continue;
    }
    const specText = file.content ?? file.ast.rootNode.text;
    for (const id of covers) {
      if (!manifestSet.has(id)) {
        violations.push({
          file: file.path,
          line: 1,
          column: 0,
          message:
            `Portal e2e spec '${file.path}' lists surface '${id}' in COVERS, but '${id}' is not in the §3a ` +
            `surface manifest (${manifestFile}). A stale or mistyped id covers nothing real. Fix the id, or ` +
            `add '${id}' to SURFACE_MANIFEST if it is a genuine new surface.`,
        });
        continue;
      }
      if (!specDrives(specText, id)) {
        const markers = NAV_MARKERS[id] ?? [];
        violations.push({
          file: file.path,
          line: 1,
          column: 0,
          message:
            `Portal e2e spec '${file.path}' claims §3a surface '${id}' in COVERS, but its body never drives that ` +
            `surface — none of its navigation markers (${markers.join(', ')}) appears in the spec. A COVERS entry ` +
            `must be backed by real navigation: open the surface (its hash route / key chord / DOM seam) and ` +
            `assert it, or drop '${id}' from this spec's COVERS so the claim cannot outrun the test.`,
        });
        continue;
      }
      covered.add(id);
      const list = coverers.get(id) ?? [];
      list.push(file.path);
      coverers.set(id, list);
    }
  }

  // 3. Every manifest surface must be covered (and genuinely driven) by at least one spec.
  for (const surface of manifest) {
    if (!covered.has(surface)) {
      violations.push({
        file: manifestFile,
        line: 1,
        column: 0,
        message:
          `§3a surface '${surface}' has NO Playwright + Chromium e2e spec covering it. Every navigable surface ` +
          `must be driven by at least one real-browser spec that declares it in COVERS AND actually navigates to ` +
          `it. Add a spec (or extend an existing one) that opens this surface and asserts it renders / its ` +
          `transitions land, and list '${surface}' in that spec's exported COVERS array.`,
      });
    }
  }

  return violations;
}
