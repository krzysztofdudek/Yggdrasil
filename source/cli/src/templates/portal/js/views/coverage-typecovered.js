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
   * refused, warning, or unverified — each rendered per-row via `enforcedRow` below),
   * so this key must never borrow a state's badge or label for it. Plain neutral glyph
   * + a literal label. Also used by coverage-view.js's excluded-files block, which is
   * likewise neither pass nor fail.
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
   * Sort priority for `typeCoveredList`'s pre-cap ordering: refused first, then an advisory
   * warning, then no-recorded-verdict, then a clean verified row last. Worse-first so that on a
   * project with more type-covered files than the cap, a real refusal can never be the row that
   * gets pushed past the fold by a run of verified rows ahead of it in raw path order — per-row
   * verdict visibility is the whole point of this listing. An entry with no `pairState` at all
   * (the unenforced and uncomputable lists, which carry no per-row verdict to prioritize) ranks
   * last of all and ties with every other such entry, so those two lists fall straight through to
   * the path tie-break below and render exactly as before.
   */
  function pairStateRank(state) {
    switch (state) {
      case 'refused': return 0;
      case 'warning': return 1;
      case 'unverified': return 2;
      case 'verified': return 3;
      default: return 4;
    }
  }

  /**
   * One row per entry (capped at `TYPE_COVERED_LIST_CAP`, with a trailing "... and N more" row
   * beyond that), in a plain mono list. Entries are sorted worst-`pairState`-first (see
   * `pairStateRank`) before the cap is applied, with path as the tie-break, so the ordering stays
   * stable rather than shuffling on every render. `formatRow` renders one entry's text; defaults
   * to the `path — type-covered as <type>` form the enforced/unenforced lists use — the
   * uncomputable list passes its own formatter to also name the cycle on every row. `buildRow`,
   * when given, replaces the plain text row entirely with a caller-built DOM node (the enforced
   * list's `enforcedRow` below, which needs a real state badge — never a plain-text row can carry
   * that) — `formatRow` is ignored for the shown rows in that case, but the "... and N more"
   * summary row always stays plain text regardless of which one was passed.
   */
  function typeCoveredList(cls, entries, formatRow, buildRow) {
    var render = formatRow || function (e) { return e.path + ' — type-covered as ' + e.type; };
    var list = dom.el('div', 'cov-typelist ' + cls);
    var sorted = entries.slice().sort(function (a, b) {
      var byState = pairStateRank(a.pairState) - pairStateRank(b.pairState);
      if (byState !== 0) return byState;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    var shown = sorted.slice(0, TYPE_COVERED_LIST_CAP);
    for (var i = 0; i < shown.length; i += 1) {
      list.appendChild(buildRow ? buildRow(shown[i]) : dom.el('div', 'cov-typerow mono', render(shown[i])));
    }
    if (sorted.length > TYPE_COVERED_LIST_CAP) {
      list.appendChild(dom.el('div', 'cov-typerow cov-typerow-more', '... and ' + (sorted.length - TYPE_COVERED_LIST_CAP) + ' more'));
    }
    return list;
  }

  /**
   * One row in the ENFORCED type-covered list — the one list whose entries carry a real
   * `pairState` (verified / refused / unverified / warning; never `n/a` — see
   * `PortalTypeCoveredFile.pairState`'s own doc). Renders the honest state badge from the
   * shared state model (never an ad-hoc glyph or color), then the path + matched type, then —
   * for `refused` AND `warning` only — the refusal reason(s) beneath the row, reusing the same
   * `.cov-member-what` pre-wrapped muted-line treatment the worklist already uses for a
   * reviewer's reason text. `warning` gets its reason rendered too: an advisory refusal is
   * still a refusal with a real reason, and dropping it here would repeat the exact information
   * loss this per-row rendering exists to remove. The unenforced/uncomputable lists never call
   * this — neither carries a `pairState` to badge.
   */
  function enforcedRow(f) {
    var row = dom.el('div', 'cov-typerow mono');
    row.appendChild(Yg.states.badge(f.pairState));
    row.appendChild(dom.el('span', null, ' ' + f.path + ' — type-covered as ' + f.type));
    if (f.reasons && f.reasons.length && (f.pairState === 'refused' || f.pairState === 'warning')) {
      row.appendChild(dom.el('span', 'cov-member-what', f.reasons.join('\n')));
    }
    return row;
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

    // `enforced` names architecture-level status, never a recorded verdict — the real verdict
    // per enforced file is `pairState` (worst-state-wins over its nodeless pairs, an advisory
    // refusal already folded down to `warning` by the same `displayPairState` transform every
    // other surface reads through). Three SEPARATE, honest counts — never folded into one
    // bucket, and a `warning` never silently added to `refused` (that would repeat the exact
    // "refused reads as unverified" collapse this per-file rendering exists to remove):
    //   - refusedCount    — a real, blocking "no" (== what yg check blocks on).
    //   - warningCount    — a refusal on an ADVISORY aspect: non-blocking signal, its own figure.
    //   - unverifiedCount — no recorded verdict at all yet (cold, or gone stale since an edit).
    // A file whose pairState is `verified` contributes to none of the three — it needs no callout.
    var refusedCount = typeCoveredEnforced.filter(function (f) { return f.pairState === 'refused'; }).length;
    var warningCount = typeCoveredEnforced.filter(function (f) { return f.pairState === 'warning'; }).length;
    var unverifiedCount = typeCoveredEnforced.filter(function (f) { return f.pairState === 'unverified'; }).length;

    // Shown as its own line, never inside "not in coverage fraction", so it is never read
    // as excluded from the ratio it actually contributes to. Omitted when zero (typeLevel
    // off, or no enforced file) — flag-off output stays unchanged.
    if (typeCoveredEnforced.length > 0) {
      ledger.appendChild(dom.el('div', 'cov-hair'));
      var typeCovered = dom.el('div', 'cov-nonpair');
      typeCovered.appendChild(dom.el('span', 'cov-nptag', 'counted above, no component of their own:'));
      var enforcedSuffix = 'satisfied by a matched type';
      if (refusedCount > 0 || warningCount > 0 || unverifiedCount > 0) {
        var clause = refusedCount + ' refused';
        if (warningCount > 0) clause += ', ' + warningCount + ' advisory';
        clause += ', ' + unverifiedCount + ' with no recorded verdict';
        enforcedSuffix += '; ' + clause;
      }
      typeCovered.appendChild(neutralKey(typeCoveredEnforced.length, 'type-covered', enforcedSuffix));
      ledger.appendChild(typeCovered);
      ledger.appendChild(typeCoveredList('cov-typelist-ok', typeCoveredEnforced, null, enforcedRow));
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
