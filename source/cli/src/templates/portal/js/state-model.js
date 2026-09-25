/*
 * The honest-state taxonomy — the spine of the whole portal.
 *
 * Eight distinct render states, each carried by color + GLYPH + label + border-style
 * (never color alone — accessibility), exactly as the visual-foundations reference
 * defines them. "verified" is the ONLY green: a check ran, the rule passed, AND the stored
 * hash still matches the current inputs. The others are deliberately, visibly distinct
 * and must NEVER be collapsed into one "green". This module is the single source of
 * truth a renderer reads — no view re-invents a glyph or a color.
 *
 * Five of these (verified / refused / unverified / no-rule / warning) are the
 * PortalNode.state values the contract enumerates; the remaining three
 * (not-applicable / suppressed / draft) are pair/aspect-level honest states, plus
 * "boundary" for a live undeclared-dependency violation. All eight render here so the
 * legend, the panels, and the cells share one honest vocabulary.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});

  // Glyph + border + plain-language label for every honest state. The one-line explanation
  // is NOT held here: plain() reads it from the glossary (glossary.js), the one place the
  // words are defined, so a tooltip, the legend and the docs Glossary never diverge.
  var STATE_META = {
    verified: {
      glyph: '✓', // check
      label: 'verified',
      border: 'solid',
    },
    refused: {
      glyph: '✕', // cross
      label: 'refused',
      border: 'solid',
    },
    unverified: {
      glyph: '◌', // dashed circle
      label: 'unverified',
      border: 'dashed',
    },
    'no-rule': {
      glyph: '⊖', // minus-circle
      label: 'no rule',
      border: 'dotted',
    },
    warning: {
      glyph: '▲', // triangle (advisory)
      label: 'warning',
      border: 'dashed',
    },
    'not-applicable': {
      glyph: '–', // en-dash
      label: 'not applicable',
      border: 'none',
    },
    suppressed: {
      glyph: '⛉', // shield-like waiver mark
      label: 'waived',
      border: 'dashed',
    },
    draft: {
      glyph: '‖', // double bar (paused)
      label: 'draft',
      border: 'dotted',
    },
    boundary: {
      glyph: '⚡', // zap
      label: 'live boundary',
      border: 'hazard',
    },
  };

  // The canonical order the legend renders in (mirrors the foundations reference).
  var STATE_ORDER = [
    'verified',
    'refused',
    'unverified',
    'no-rule',
    'warning',
    'not-applicable',
    'suppressed',
    'draft',
    'boundary',
  ];

  /** Metadata for a state, falling back to no-rule for an unknown value (never throws). */
  function meta(state) {
    return STATE_META[state] || STATE_META['no-rule'];
  }

  /** The glyph for a state (color is carried by the CSS class, never alone). */
  function glyph(state) {
    return meta(state).glyph;
  }

  /** The plain-language label for a state. */
  function label(state) {
    return meta(state).label;
  }

  /**
   * The plain-language one-line explanation (tooltip text) for a state, read from the
   * glossary at call time (both modules are loaded by then); an unknown state falls back to
   * the no-rule wording, like meta().
   */
  function plain(state) {
    var g = Yg.glossary;
    if (!g || !g.lookup) return '';
    return g.lookup(STATE_META[state] ? state : 'no-rule') || '';
  }

  /** The CSS state class a renderer attaches so color + border come from one place. */
  function cssClass(state) {
    return 'state-' + (STATE_META[state] ? state : 'no-rule');
  }

  /**
   * Build an accessible state badge: a glyph element carrying the state color/border (from
   * the CSS class) plus an aria-label of the plain wording, so the state is conveyed by
   * shape AND text, never color alone. Returns a <span> ready to insert.
   */
  function badge(state) {
    var m = meta(state);
    var node = Yg.dom.el('span', 'state-glyph ' + cssClass(state), m.glyph);
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', m.label);
    node.setAttribute('title', plain(state));
    return node;
  }

  Yg.states = {
    ORDER: STATE_ORDER,
    meta: meta,
    glyph: glyph,
    label: label,
    plain: plain,
    cssClass: cssClass,
    badge: badge,
  };
})();
