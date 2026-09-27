/*
 * The glossary — the one place Yggdrasil's words are defined.
 *
 * The portal must be legible to a human who does not speak the engine's vocabulary, so
 * every internal term carries a plain definition that appears as a tooltip wherever the
 * term is shown, and the honest-state legend (state-model.js) reads its explanations from
 * here too. The entries themselves are in glossary-entries.js, which must load first; the
 * same entries are the docs site's Glossary page (docs/glossary.md is generated from them).
 *
 * Browser globals only — the tooltip is a hover/focus popover built from page DOM; no
 * network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});

  // The entries live in glossary-entries.js, loaded before this module.
  var ENTRIES = Yg.glossaryEntries || [];

  // term id -> plain definition. Keyed by a stable lowercase id, not display text.
  // Backticks mark code in the docs page; a tooltip shows the plain text without them.
  var TERMS = {};
  for (var i = 0; i < ENTRIES.length; i += 1) TERMS[ENTRIES[i].id] = ENTRIES[i].def.replace(/`/g, '');

  /** The plain definition for a term id, or null when the term is unknown. */
  function lookup(termId) {
    var key = String(termId || '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(TERMS, key) ? TERMS[key] : null;
  }

  /**
   * Wrap a piece of text as a glossary term: a <span class="term"> carrying the plain
   * definition both as a native title and as an aria-label, so the meaning is reachable on
   * hover AND by a screen reader. Falls back to plain text when the term is unknown.
   */
  function term(termId, displayText) {
    var def = lookup(termId);
    var text = displayText === undefined ? String(termId) : displayText;
    if (!def) return Yg.dom.el('span', null, text);
    var node = Yg.dom.el('span', 'term', text);
    node.setAttribute('tabindex', '0');
    node.setAttribute('title', def);
    node.setAttribute('aria-label', text + ': ' + def);
    node.setAttribute('data-term', String(termId).toLowerCase());
    return node;
  }

  Yg.glossary = { lookup: lookup, term: term, entries: ENTRIES, _terms: TERMS };
})();
