/*
 * V4 part (a) — the allowed-relations matrix (Canvas grid + DOM mirror).
 *
 * The architecture's allowed-relations rules as a node-type × node-type grid: a filled cell
 * means the architecture permits that relation type from the row type to the column type; an
 * empty cell means it permits none (a forbidden pair). This is *allowed*, not *actual* —
 * conformance is the separate live boundary check. The dense grid is drawn on Canvas 2D (the
 * one place §3a sanctions Canvas), with a DOM-list MIRROR beside it so the matrix is not
 * opaque to a screen reader (Canvas alone is). Colors come from CSS custom properties read off
 * the page; this module paints relation presence only — it never paints a verdict state, so it
 * does not (and must not) invent a green.
 *
 * Browser globals only — reads the already-resolved PortalData; no network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;
  Yg.views = Yg.views || {};
  Yg.matrix = {};

  var CELL = 26;
  var HEADER = 92;
  var ROWLBL = 150;

  // Relation type → a stable, colorblind-safe hue (presence marker only, not a state).
  var REL_COLOR = {
    calls: '#0d74ce',
    uses: '#208368',
    extends: '#9a6700',
    implements: '#8e4ec6',
    emits: '#d6409f',
    listens: '#d6409f',
  };

  // How many distinct relation types the engine resolves per type (uses / calls / extends /
  // implements / emits / listens — core/allowed-relation-types.ts RELATION_TYPES.length),
  // mirrored here as a literal since a browser module cannot import the engine constant.
  var REL_TYPE_COUNT = 6;

  /** The sorted union of every type that appears as a relation source or target. */
  Yg.matrix.axisTypes = function (types) {
    var ids = (types || []).map(function (t) {
      return t.id;
    });
    return ids.slice().sort();
  };

  /**
   * The relation types allowed from `rowType` to `colType`. `typesById[rowType].allowed` is the
   * engine's ALREADY-RESOLVED allow-list (`PortalTypeAllowed[]`): an omitted entry is forbidden,
   * `targets === 'any'` means that relation type may target every component kind — membership,
   * not a raw-row lookup.
   *
   * Returns `null` — NEVER `[]` — when the row type or its allow-list data is ABSENT. `[]` stays
   * reserved for a real, resolved answer ("this row's allow-list is present and permits nothing
   * here"); a data gap is not that answer, and callers must not paint the two the same way (an
   * empty cell / "forbidden" reading). Unreachable today — `allowed` is a required, always-
   * populated contract field — this is hardening against a future field rename silently falling
   * through to the forbidding branch, which is exactly how the defect this task fixes arose.
   */
  Yg.matrix.allowedBetween = function (typesById, rowType, colType) {
    var row = typesById[rowType];
    if (!row || !row.allowed) return null;
    var out = [];
    for (var i = 0; i < row.allowed.length; i += 1) {
      var a = row.allowed[i];
      if (a.targets === 'any' || a.targets.indexOf(colType) !== -1) out.push(a.type);
    }
    return out;
  };

  /** True when `type.allowed` is the full six-entries-all-'any' shape: no restriction declared. */
  function isUnrestricted(type) {
    return !!type && !!type.allowed && type.allowed.length === REL_TYPE_COUNT && type.allowed.every(function (a) {
      return a.targets === 'any';
    });
  }

  /** True when EVERY type on the axis is unrestricted — the architecture declares no relation restrictions at all. */
  function allUnrestricted(axis, typesById) {
    if (!axis.length) return false;
    for (var i = 0; i < axis.length; i += 1) {
      if (!isUnrestricted(typesById[axis[i]])) return false;
    }
    return true;
  }

  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      return (v && v.trim()) || fallback;
    } catch (_e) {
      return fallback;
    }
  }

  function drawCanvas(canvas, axis, typesById) {
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return; // jsdom/test sandbox without canvas — the DOM mirror carries the data
    var n = axis.length;
    var muted = cssVar('--text-secondary', '#60646c');
    var border = cssVar('--border-subtle', '#d9d9e0');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    // Column headers (rotated) + row labels.
    for (var c = 0; c < n; c += 1) {
      ctx.save();
      ctx.translate(ROWLBL + c * CELL + CELL / 2, HEADER - 6);
      ctx.rotate(-Math.PI / 3);
      ctx.fillStyle = muted;
      ctx.textAlign = 'left';
      ctx.fillText(axis[c], 0, 0);
      ctx.restore();
    }
    for (var r = 0; r < n; r += 1) {
      ctx.fillStyle = muted;
      ctx.textAlign = 'right';
      ctx.fillText(axis[r], ROWLBL - 8, HEADER + r * CELL + CELL / 2);
    }

    // Cells.
    ctx.textAlign = 'center';
    for (var ri = 0; ri < n; ri += 1) {
      for (var ci = 0; ci < n; ci += 1) {
        var x = ROWLBL + ci * CELL;
        var y = HEADER + ri * CELL;
        ctx.strokeStyle = border;
        ctx.strokeRect(x, y, CELL, CELL);
        if (ri === ci) {
          ctx.fillStyle = cssVar('--surface-2', '#f0f0f3');
          ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
          continue;
        }
        var rels = Yg.matrix.allowedBetween(typesById, axis[ri], axis[ci]);
        if (rels === null) {
          // A data gap — a distinct "unknown" glyph, never a blank (forbidden) cell and never a
          // colored (allowed) dot.
          ctx.fillStyle = muted;
          ctx.fillText('?', x + CELL / 2, y + CELL / 2);
        } else if (rels.length) {
          ctx.fillStyle = REL_COLOR[rels[0]] || muted;
          ctx.beginPath();
          ctx.arc(x + CELL / 2, y + CELL / 2, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  /**
   * A DOM-list mirror of the matrix: every allowed (row → rel → col) edge, screen-reader-legible.
   * Two collapses keep this legible on a permissive project instead of emitting near-identical
   * rows: (1) `unrestricted` — EVERY type on the axis is the full six-entries-all-'any' shape, so
   * the whole mirror collapses to one sentence instead of an (axis.length² - axis.length)-row
   * grid; (2) per-row — a row type that is itself all-'any' emits ONE line instead of the N-1
   * column rows it would otherwise take (still checked even when the axis as a whole is mixed).
   */
  function buildMirror(axis, typesById, unrestricted) {
    var mirror = dom.el('div', 'mtx-mirror');
    mirror.setAttribute('aria-label', 'Allowed relations, as a list');
    if (unrestricted) {
      mirror.appendChild(dom.el('p', 'mtx-empty', 'this architecture declares no relation restrictions yet — every dependency is currently allowed'));
      return mirror;
    }
    var any = false;
    for (var ri = 0; ri < axis.length; ri += 1) {
      var rowType = typesById[axis[ri]];
      if (!rowType || !rowType.allowed) {
        // A data gap for this row — a visible gap, never silently skipped (indistinguishable
        // from "every relation type forbidden") and never folded into the collapsed 'any' line
        // below (also false — a missing allow-list is not "no restriction").
        any = true;
        var gapLine = dom.el('div', 'mtx-mirror-row');
        gapLine.appendChild(dom.el('span', 'mono', axis[ri]));
        gapLine.appendChild(dom.el('span', 'mtx-arrow', ' → '));
        gapLine.appendChild(dom.el('span', 'mtx-rels', 'allow-list unavailable — data missing, not a restriction'));
        mirror.appendChild(gapLine);
        continue;
      }
      if (isUnrestricted(rowType)) {
        any = true;
        var anyLine = dom.el('div', 'mtx-mirror-row');
        anyLine.appendChild(dom.el('span', 'mono', axis[ri]));
        anyLine.appendChild(dom.el('span', 'mtx-arrow', ' → '));
        anyLine.appendChild(dom.el('span', 'mtx-rels', 'any component type (no restriction declared)'));
        mirror.appendChild(anyLine);
        continue;
      }
      for (var ci = 0; ci < axis.length; ci += 1) {
        if (ri === ci) continue;
        var rels = Yg.matrix.allowedBetween(typesById, axis[ri], axis[ci]);
        if (!rels || !rels.length) continue;
        any = true;
        var line = dom.el('div', 'mtx-mirror-row');
        line.appendChild(dom.el('span', 'mono', axis[ri]));
        line.appendChild(dom.el('span', 'mtx-arrow', ' → '));
        line.appendChild(dom.el('span', 'mtx-rels', rels.join(' / ')));
        line.appendChild(dom.el('span', 'mtx-arrow', ' → '));
        line.appendChild(dom.el('span', 'mono', axis[ci]));
        mirror.appendChild(line);
      }
    }
    if (!any) mirror.appendChild(dom.el('p', 'mtx-empty', 'The architecture declares no allowed relations between these types — every pair is a forbidden cell.'));
    return mirror;
  }

  function legend() {
    var box = dom.el('div', 'mtx-legend');
    for (var rel in REL_COLOR) {
      if (!Object.prototype.hasOwnProperty.call(REL_COLOR, rel)) continue;
      if (rel === 'listens') continue; // emits/listens share one swatch
      var k = dom.el('span', 'mtx-legend-k');
      var sw = dom.el('span', 'mtx-swatch');
      sw.style.background = REL_COLOR[rel];
      k.appendChild(sw);
      k.appendChild(dom.el('span', null, rel === 'emits' ? 'emits/listens' : rel));
      box.appendChild(k);
    }
    // Scoped to the grid CELL, not to a collapsed mirror row: a row that collapses to "any
    // component type (no restriction declared)" is not empty — it says so explicitly — so this
    // note must never be read as applying to it.
    var empty = dom.el('span', 'mtx-legend-k mtx-legend-empty', 'empty cell = forbidden by architecture');
    box.appendChild(empty);
    // The '?' glyph is a data gap (allow-list data absent), never a forbidding claim — kept
    // distinct from the "empty cell" note above so the two can never be conflated.
    var gap = dom.el('span', 'mtx-legend-k mtx-legend-empty', '? = data gap, not a restriction');
    box.appendChild(gap);
    return box;
  }

  /** Render the allowed-relations matrix (Canvas + DOM mirror) into `mount`. */
  Yg.matrix.render = function (mount, data) {
    var typesById = {};
    (data.types || []).forEach(function (t) {
      typesById[t.id] = t;
    });
    var axis = Yg.matrix.axisTypes(data.types);
    // Computed once, shared by the lead paragraph and the mirror below — a fresh project with no
    // relations table declares no restriction anywhere, so both surfaces say so ONCE instead of
    // painting a grid's worth of identical "everything is allowed" text.
    var unrestricted = allUnrestricted(axis, typesById);

    var leadText = unrestricted
      ? 'this architecture declares no relation restrictions yet — every dependency is currently allowed'
      : "What's allowed to depend on what — the architecture's node-type × node-type rules. An empty cell means no relation is permitted there. This is allowed, not actual: conformance is the live boundary check below.";
    mount.appendChild(dom.el('p', 'view-lead', leadText));

    // The dense grid keeps its intrinsic pixel size and scrolls WITHIN its own container
    // (overflow-x on .mtx-scroll), so a wide matrix never pushes the page into a horizontal
    // scrollbar — it stays legible and contained instead of being scaled down.
    var scroll = dom.el('div', 'mtx-scroll');
    var canvas = document.createElement('canvas');
    canvas.className = 'mtx-canvas';
    canvas.width = ROWLBL + axis.length * CELL + 4;
    canvas.height = HEADER + axis.length * CELL + 4;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Allowed-relations matrix; a list mirror follows');
    scroll.appendChild(canvas);
    mount.appendChild(scroll);
    drawCanvas(canvas, axis, typesById);

    mount.appendChild(legend());
    mount.appendChild(buildMirror(axis, typesById, unrestricted));
  };
})();
