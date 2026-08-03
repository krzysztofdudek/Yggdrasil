/*
 * V2 Coverage & Audit — the type-covered per-file ledger.
 *
 * Split out of coverage-view.js so each file stays a focused unit (mirrors the
 * panel-view.js / panel-aspect.js split). Renders the three DISTINCT lines a
 * type-covered file can land on — enforced (its own pairs are already counted
 * in the bar above), unenforced (matched a type with nothing that applies —
 * `yg check`'s "satisfy coverage with no enforcement"), and uncomputable (an
 * aspect `implies` cycle stopped the type's rules from ever being resolved —
 * the ONE case "no rule applies" cannot cover; the honest answer is unknown,
 * never a resolved "nothing applies", per docs/configuration.md) — plus the
 * neutral count-key glyph the enforced line shares with the excluded-files
 * block in coverage-view.js.
 *
 * Browser globals only — reads the already-resolved PortalData; no network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;

  /**
   * A labelled count key: glyph + count + plain label, all from the shared state model.
   * The SAME shape coverage-view.js's own `key` builds (used there for pair-state keys);
   * duplicated here only because the "checked by nothing" line below needs the `no-rule`
   * state badge and this module stays self-contained rather than reaching back into
   * coverage-view.js's local scope for it.
   */
  function key(state, count, suffix) {
    var k = dom.el('span', 'cov-key');
    k.appendChild(Yg.states.badge(state));
    k.appendChild(dom.el('b', null, String(count)));
    k.appendChild(dom.el('span', 'cov-key-lbl', Yg.states.label(state)));
    if (suffix) k.appendChild(dom.el('span', 'cov-key-sub', suffix));
    return k;
  }

  /**
   * A count key in the SAME shape as `key` above, for a count that is not one of the
   * nine honest states — a type-covered file has its own real verdict (verified,
   * refused, or unverified, tallied in the bar above), so this key must never borrow a
   * state's badge or label for it. Plain neutral glyph + a literal label. Also used by
   * coverage-view.js's excluded-files block, which is likewise neither pass nor fail.
   */
  function neutralKey(count, label, suffix) {
    var k = dom.el('span', 'cov-key');
    var mark = dom.el('span', 'state-glyph reslink-neutral', '•');
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', 'satisfied by a matched type');
    k.appendChild(mark);
    k.appendChild(dom.el('b', null, String(count)));
    k.appendChild(dom.el('span', 'cov-key-lbl', label));
    if (suffix) k.appendChild(dom.el('span', 'cov-key-sub', suffix));
    return k;
  }

  /**
   * A count key in the SAME shape as `key`/`neutralKey`, for a type-covered file whose
   * matched type's rules an aspect `implies` cycle stopped from ever being resolved. Its own
   * glyph and wording — never the "no rule" badge (that would repeat the exact substitution
   * this state exists to rule out: "we could not determine what checks this file" read back as
   * "nothing checks this file") and never the neutral "satisfied" mark either (the cascade
   * never ran, so nothing was found to be satisfied).
   */
  function unknownKey(count, label, suffix) {
    var k = dom.el('span', 'cov-key');
    var mark = dom.el('span', 'state-glyph reslink-unknown', '?');
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', 'rules could not be worked out');
    k.appendChild(mark);
    k.appendChild(dom.el('b', null, String(count)));
    k.appendChild(dom.el('span', 'cov-key-lbl', label));
    if (suffix) k.appendChild(dom.el('span', 'cov-key-sub', suffix));
    return k;
  }

  /**
   * Cap on how many file rows one per-file listing renders before summarizing the rest —
   * matches `core/type-visibility.ts`'s own `SAMPLE_CAP` exactly (the same cap `yg check`'s
   * zero-enforcement/uncomputable file samples use), so a project with hundreds of type-covered
   * files never grows this page in proportion to its file count while the command-line stays
   * capped. Counts elsewhere (the chips, the CSV/JSON exports) are never capped — only this
   * raw-path listing is.
   */
  var TYPE_COVERED_LIST_CAP = 12;

  /**
   * One row per entry (capped at `TYPE_COVERED_LIST_CAP`, with a trailing "... and N more" row
   * beyond that), in a plain mono list. `formatRow` renders one entry's text; defaults to the
   * `path — type-covered as <type>` form the enforced/unenforced lists use — the uncomputable
   * list passes its own formatter to also name the cycle on every row.
   */
  function typeCoveredList(cls, entries, formatRow) {
    var render = formatRow || function (e) { return e.path + ' — type-covered as ' + e.type; };
    var list = dom.el('div', 'cov-typelist ' + cls);
    var shown = entries.slice(0, TYPE_COVERED_LIST_CAP);
    for (var i = 0; i < shown.length; i += 1) {
      list.appendChild(dom.el('div', 'cov-typerow mono', render(shown[i])));
    }
    if (entries.length > TYPE_COVERED_LIST_CAP) {
      list.appendChild(dom.el('div', 'cov-typerow cov-typerow-more', '... and ' + (entries.length - TYPE_COVERED_LIST_CAP) + ' more'));
    }
    return list;
  }

  /**
   * Append the three type-covered lines to `ledger` — enforced, unenforced, and
   * uncomputable — each omitted entirely when its own count is zero. `residue` is
   * `PortalData.residue` (or the same-shaped fallback coverage-view.js already builds).
   */
  function renderBlocks(ledger, residue) {
    // A type-covered file's per-file enforcement state — path + matched type + whether
    // anything actually checks it (see PortalTypeCoveredFile). Split into DISTINCT
    // lines, never one bare count folding them together: an ENFORCED file's own pairs
    // against its matched type's aspects ARE counted in the bar's fraction above (it just
    // has no component of its own to attach to); an UNENFORCED file has NO pair counted
    // anywhere — matched by a type, checked by nothing, the exact state yg check names
    // under "satisfy coverage with no enforcement". Neither line borrows the other's
    // wording or badge, so a project whose classifying types carry no rules yet cannot
    // read as accounted-for just because a count happens to be nonzero.
    var typeCoveredEntries = residue.typeCovered || [];
    var typeCoveredEnforced = typeCoveredEntries.filter(function (f) { return f.enforced; });
    var typeCoveredUnenforced = typeCoveredEntries.filter(function (f) { return !f.enforced; });

    // `enforced` names architecture-level status, never a recorded verdict (F2) — how many
    // of the enforced files have no recorded lock entry for at least one of their rules, the
    // same lock-derived fact plain `yg check`'s qualified "N unverified" wording, `yg owner
    // --file`, and `yg context --file` already carry for the identical pair.
    var typeCoveredUnverified = typeCoveredEnforced.filter(function (f) { return f.unverified; }).length;

    // Shown as its own line, never inside "not in coverage fraction", so it is never read
    // as excluded from the ratio it actually contributes to. Omitted when zero (typeLevel
    // off, or no enforced file) — flag-off output stays unchanged.
    if (typeCoveredEnforced.length > 0) {
      ledger.appendChild(dom.el('div', 'cov-hair'));
      var typeCovered = dom.el('div', 'cov-nonpair');
      typeCovered.appendChild(dom.el('span', 'cov-nptag', 'counted above, no component of their own:'));
      var enforcedSuffix = 'satisfied by a matched type' +
        (typeCoveredUnverified > 0 ? '; ' + typeCoveredUnverified + ' with no recorded verdict' : '');
      typeCovered.appendChild(neutralKey(typeCoveredEnforced.length, 'type-covered', enforcedSuffix));
      ledger.appendChild(typeCovered);
      ledger.appendChild(typeCoveredList('cov-typelist-ok', typeCoveredEnforced, function (e) {
        return e.path + ' — type-covered as ' + e.type + (e.unverified ? ' — unverified' : '');
      }));
    }

    // A file matched by a type whose cascade produced NO applicable rule at all: no pair,
    // no bar segment, nothing counted anywhere above. This is the state a bare "type-covered"
    // count could never distinguish from the enforced line above it — rendered with the SAME
    // honest "no rule" badge a no-rule NODE gets (never the neutral "satisfied" mark, which
    // would repeat the exact dishonesty this line exists to correct), and named by file so it
    // cannot vanish behind a number the way it did before this line existed.
    if (typeCoveredUnenforced.length > 0) {
      ledger.appendChild(dom.el('div', 'cov-hair'));
      var noEnforce = dom.el('div', 'cov-nonpair');
      noEnforce.appendChild(dom.el('span', 'cov-nptag', 'matched by a type with no rule that applies — checked by nothing:'));
      noEnforce.appendChild(key('no-rule', typeCoveredUnenforced.length, 'satisfy coverage with no enforcement'));
      ledger.appendChild(noEnforce);
      ledger.appendChild(typeCoveredList('cov-typelist-bad', typeCoveredUnenforced));
    }

    // A file whose matched type's rules an aspect `implies` cycle stopped from ever being
    // resolved — the ONE case "no rule applies" cannot cover (docs/configuration.md is explicit
    // about this): the cascade never ran, so the honest answer is UNKNOWN, not "satisfies
    // coverage with no enforcement". Its own line, its own glyph — never the "no rule" badge
    // above (that would report a resolved fact where none was reached) and never the neutral
    // "satisfied" mark either. Every row names the cycle, the SAME sentence yg check, yg context
    // --file, and yg owner --file already print for the identical fact.
    var typeCoveredUncomputable = residue.typeCoveredUncomputable || [];
    if (typeCoveredUncomputable.length > 0) {
      ledger.appendChild(dom.el('div', 'cov-hair'));
      var uncomputable = dom.el('div', 'cov-nonpair');
      uncomputable.appendChild(dom.el('span', 'cov-nptag', 'matched by a type whose rules could not be worked out — the honest answer is unknown, not "no rule applies":'));
      uncomputable.appendChild(unknownKey(typeCoveredUncomputable.length, 'unknown', 'aspect implies cycle'));
      ledger.appendChild(uncomputable);
      ledger.appendChild(typeCoveredList('cov-typelist-unknown', typeCoveredUncomputable, function (e) {
        return e.path + ' — type-covered as ' + e.type + ' — ' + e.why;
      }));
    }
  }

  Yg.coverageTypeCovered = {
    neutralKey: neutralKey,
    unknownKey: unknownKey,
    typeCoveredList: typeCoveredList,
    renderBlocks: renderBlocks,
  };
})();
