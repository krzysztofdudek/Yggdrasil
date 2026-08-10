/*
 * V2 Coverage & Audit — the full Coverage-Truth Ledger.
 *
 * The precise, honest audit (§3a V2, §3.1): a 100%-width verdict bar over the full
 * expected-pair universe (verified — sub-split billed-LLM vs free-deterministic — / refused /
 * unverified, each color + glyph + label + exact count); a hairline-separated NON-PAIR track
 * (no-rule / draft / not-applicable) that is counted but structurally barred from the
 * coverage fraction; LIVE-badged counters (boundary / validator / log-missing) that equal what
 * yg check enforces; a provenance line; the rule-grouped needs-attention worklist in the
 * honesty-priority order the pipeline already sorted; and a jump-to-next-unresolved that, on
 * an empty worklist, repoints to the top residue item rather than dead-ending. Every count is
 * read from the live PortalData (== yg check); nothing here is a literal, nothing collapses to
 * green.
 *
 * Browser globals only — reads the already-resolved PortalData; no network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;
  Yg.views = Yg.views || {};

  /** A bar segment with a non-zero width (collapses to nothing at 0 so the bar stays honest). */
  function barSeg(cls, flex, label) {
    if (flex <= 0) return null;
    var seg = dom.el('div', 'cov-seg ' + cls, label);
    seg.style.flex = String(flex);
    return seg;
  }

  /** A labelled count key: glyph + count + plain label, all from the shared state model. */
  function key(state, count, suffix) {
    var k = dom.el('span', 'cov-key');
    k.appendChild(Yg.states.badge(state));
    k.appendChild(dom.el('b', null, String(count)));
    k.appendChild(dom.el('span', 'cov-key-lbl', Yg.states.label(state)));
    if (suffix) k.appendChild(dom.el('span', 'cov-key-sub', suffix));
    return k;
  }

  /**
   * A LIVE-badged counter. `value` is a number read from the live data, or the string 'UNKNOWN'
   * when the underlying check could not run — never a fabricated zero. An explicit number is
   * always rendered (no hidden row); an optional `onClick` routes the chip.
   */
  function liveChip(value, label, onClick) {
    var unknown = value === 'UNKNOWN';
    var chip = dom.el(onClick ? 'button' : 'div', 'cov-live' + (onClick ? ' cov-live-btn' : ''));
    if (onClick) {
      chip.type = 'button';
      chip.addEventListener('click', onClick);
    }
    chip.appendChild(dom.el('span', 'cov-livebadge', 'LIVE'));
    chip.appendChild(dom.el('b', null, String(value)));
    chip.appendChild(dom.el('span', null, label));
    if (unknown) chip.appendChild(dom.el('span', 'cov-key-sub', 'check could not run — not clean, not zero'));
    else if (value === 0) chip.appendChild(dom.el('span', 'cov-key-sub', 'none on current inputs'));
    return chip;
  }

  function renderBar(stage, data, ctx) {
    var c = data.meta.counts;
    var nav = ctx && ctx.navigate ? ctx.navigate : function () {};
    var boundary = data.boundary || { unknown: false, phantom: [], forbiddenType: [] };
    var residue = data.residue || { noRuleNodes: [], uncoveredFiles: [], typeCovered: [], typeCoveredUncomputable: [], excludedFiles: [] };
    var ledger = dom.el('div', 'cov-ledger');

    var head = dom.el('div', 'cov-lhead');
    var frac = dom.el('span', 'cov-frac', c.verified + ' ');
    frac.appendChild(dom.el('span', 'cov-den', '/ ' + c.pairsTotal));
    head.appendChild(frac);
    head.appendChild(dom.el('span', 'cov-lbl', 'expected verdict pairs verified'));
    head.appendChild(dom.el('span', 'cov-right', c.nodes + ' nodes · ' + c.aspects + ' aspects · ' + c.flows + ' flows'));
    ledger.appendChild(head);

    // The bar is sized by the real pair STATES (verified / refused / unverified), never by the
    // expected-pair kind totals — a verified segment must be exactly as wide as the verified
    // count, so an unverified pair can never paint green. The verified label states BOTH the
    // LLM-vs-deterministic makeup of the expected universe AND the real split of the verified
    // count itself (verifiedDet / verifiedLlm — tallied off the identical pairs loop `yg check`
    // uses for its own header), so a green bar can never hide how many pairs were machine-checked
    // for free vs actually reviewed by an LLM.
    // Advisory refusals are a real expected-pair state, but per the honesty model they render
    // as a NON-BLOCKING warning, never a blocking `refused`. They get their own warning-coloured
    // segment + key so the bar still accounts for every expected pair without ever showing an
    // advisory refusal as a blocking red. `refused` here is ENFORCED refusals only (== yg check).
    var advisoryRefused = c.advisoryRefused || 0;
    var bar = dom.el('div', 'cov-bar');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'verified ' + c.verified + ' of ' + c.pairsTotal + ' expected pairs');
    var segs = [
      barSeg('cov-seg-v', c.verified, c.verified > 0 ? c.verified + ' verified' : ''),
      barSeg('cov-seg-r', c.refused, ''),
      barSeg(Yg.states.cssClass('warning'), advisoryRefused, ''),
      barSeg('cov-seg-u', c.unverified, ''),
    ];
    for (var i = 0; i < segs.length; i += 1) if (segs[i]) bar.appendChild(segs[i]);
    if (!bar.firstChild) bar.appendChild(dom.el('div', 'cov-seg cov-seg-empty', 'no expected pairs'));
    ledger.appendChild(bar);

    var labels = dom.el('div', 'cov-barlabels');
    labels.appendChild(key(
      'verified',
      c.verified,
      'of ' + c.pairsLLM + ' LLM + ' + c.pairsDet + ' deterministic expected'
        + ' (' + (c.verifiedDet || 0) + ' deterministic, ' + (c.verifiedLlm || 0) + ' LLM verified)',
    ));
    labels.appendChild(key('refused', c.refused, 'enforced — blocks (== yg check)'));
    if (advisoryRefused > 0) labels.appendChild(key('warning', advisoryRefused, 'advisory refusal — does not block'));
    labels.appendChild(key('unverified', c.unverified));
    ledger.appendChild(labels);

    // The separated non-pair track — counted, shown, barred from the coverage fraction.
    ledger.appendChild(dom.el('div', 'cov-hair'));
    var nonpair = dom.el('div', 'cov-nonpair');
    nonpair.appendChild(dom.el('span', 'cov-nptag', 'not in coverage fraction:'));
    nonpair.appendChild(key('no-rule', c.noRule, 'own source'));
    nonpair.appendChild(key('draft', c.draft));
    nonpair.appendChild(key('not-applicable', c.notApplicable));
    ledger.appendChild(nonpair);

    // A type-covered file's per-file enforcement state, split into its three DISTINCT
    // lines (enforced / unenforced / uncomputable) — see coverage-typecovered.js, split
    // out of this file so each stays a focused unit.
    Yg.coverageTypeCovered.renderBlocks(ledger, residue);

    // Files deliberately excluded from coverage (coverage.excluded) — never a residue gap
    // and never enforced, but named here so an excluded file has somewhere to be found by
    // name rather than only ever being a number in the header.
    var excludedList = residue.excludedFiles || [];
    if (excludedList.length > 0) {
      ledger.appendChild(dom.el('div', 'cov-hair'));
      var excludedBlock = dom.el('div', 'cov-nonpair');
      excludedBlock.appendChild(dom.el('span', 'cov-nptag', 'deliberately excluded from coverage, never enforced:'));
      excludedBlock.appendChild(Yg.coverageTypeCovered.neutralKey(excludedList.length, 'excluded', 'under a coverage.excluded root'));
      ledger.appendChild(excludedBlock);
      var excludedRows = dom.el('div', 'cov-typelist cov-typelist-excluded');
      for (var xi = 0; xi < excludedList.length; xi += 1) {
        excludedRows.appendChild(dom.el('div', 'cov-typerow mono', excludedList[xi]));
      }
      ledger.appendChild(excludedRows);
    }

    // LIVE counters — read from the live data, never a fabricated zero. The boundary count is
    // the real undeclared + forbidden-type violation total (declared-only is legitimate, never
    // counted), or UNKNOWN when the live relation parse could not run; it routes to V4. The
    // blocking-errors count is the live yg-check error total.
    var boundaryValue = boundary.unknown
      ? 'UNKNOWN'
      : (boundary.phantom || []).length + (boundary.forbiddenType || []).length;
    var live = dom.el('div', 'cov-livewrap');
    live.appendChild(
      liveChip(boundaryValue, 'boundary violations', function () {
        nav({ view: 'relations' });
      }),
    );
    live.appendChild(liveChip(c.errors, 'blocking errors (== yg check)', undefined));
    ledger.appendChild(live);

    ledger.appendChild(
      dom.el(
        'p',
        'cov-prov',
        'Lock read at generation. Deterministic checks and the relation / architecture / mapping / strict-coverage validators are re-run live at generation; the deterministic cache is never trusted. Counts equal what yg check enforces.',
      ),
    );
    stage.appendChild(ledger);
  }

  /**
   * The first node-bearing member across every group, in group/member order — the jump
   * target for "Jump to next unresolved". `undefined` when no group carries a component
   * member (e.g. every group is repository-level or file-only), in which case the button
   * falls back to the residue link below rather than navigating nowhere.
   */
  function firstNodeMember(worklist) {
    for (var gi = 0; gi < worklist.length; gi += 1) {
      var members = worklist[gi].members || [];
      for (var mi = 0; mi < members.length; mi += 1) {
        if (members[mi].node) return members[mi].node;
      }
    }
    return undefined;
  }

  function renderWorklist(stage, data, ctx) {
    var nav = ctx && ctx.navigate ? ctx.navigate : function () {};
    var worklist = data.worklist || [];
    var coverageBlocks = data.worklistCoverage || [];
    // Coverage findings are never grouped into `worklist` (they render as their own
    // blocks, outside the rule groups) — folding them out of this count would let a
    // project whose ONLY failure is e.g. unmapped files show "Needs attention (0)" on
    // a failing build.
    var count = worklist.length + coverageBlocks.length;
    // The ONE honest gate for BOTH the calm panel and the jump button below — computed
    // once from the LIVE error/warning counts (== yg check), never from list emptiness.
    // A group excluded from `worklist` (coverage codes) can still be a failing build even
    // when `worklist` itself is empty, so a second, list-shaped proxy for "is this calm"
    // (e.g. "does any group have a node member") must never be allowed to drift from this
    // one and independently decide to say "clear".
    var calm = data.meta.counts.errors === 0 && data.meta.counts.warnings === 0;

    var title = dom.el('div', 'cov-section');
    title.appendChild(dom.el('span', null, 'Needs attention'));
    title.appendChild(dom.el('span', 'cov-section-count', '(' + count + ')'));
    var jump = dom.el('button', 'cov-jump');
    jump.type = 'button';
    if (calm) {
      jump.textContent = 'All clear — view the residue →';
      jump.classList.add('cov-jump-residue');
      jump.addEventListener('click', function () {
        nav({ view: 'suppressions' });
      });
    } else {
      var jumpNode = firstNodeMember(worklist);
      if (jumpNode) {
        jump.textContent = 'Jump to next unresolved →';
        jump.addEventListener('click', function () {
          nav({ view: 'tree', node: jumpNode });
        });
      } else {
        // Not calm, but no group carries a component to jump to (every group is
        // repository-level or file-only, e.g. a coverage-only red build). Never say
        // "clear" here — that would be the exact "All clear on a failing build" defect
        // this round exists to remove, just relocated from the panel to the button.
        jump.textContent = 'No component to jump to — see the findings below';
      }
    }
    title.appendChild(jump);
    stage.appendChild(title);

    if (calm) {
      var calmEl = dom.el('div', 'cov-calm');
      calmEl.appendChild(dom.el('p', null, 'No refusals and nothing unverified on current inputs. Absence of red is not a pass — the residue above (no-rule nodes, unmapped files, waivers) is still worth a look.'));
      stage.appendChild(calmEl);
      return;
    }

    Yg.views.coverageWorklist.renderRows(stage, data, nav);
  }

  /** A keyboard-operable export trigger (a native <button>, focusable + Enter/Space-activatable). */
  function exportBtn(label, aria, onClick) {
    var b = dom.el('button', 'exp-btn', label);
    b.type = 'button';
    b.setAttribute('aria-label', aria);
    b.addEventListener('click', onClick);
    return b;
  }

  /** The portable-artifact export bar (CSV of the coverage summary + the no-rule residue, JSON bundle). */
  function renderExport(stage, data) {
    if (!Yg.exporter) return;
    var bar = dom.el('div', 'exp-bar');
    bar.appendChild(dom.el('span', 'exp-lbl', 'Export the audit (in-page, no network):'));
    bar.appendChild(exportBtn('Coverage CSV', 'Download the coverage summary as CSV', function () {
      Yg.exporter.exportCoverageCsv(data);
    }));
    bar.appendChild(exportBtn('Residue CSV', 'Download the no-rule nodes and unmapped files as CSV', function () {
      Yg.exporter.exportResidueCsv(data);
    }));
    bar.appendChild(exportBtn('JSON bundle', 'Download the full audit bundle (coverage, residue, suppressions) as JSON', function () {
      Yg.exporter.exportJson(data);
    }));
    stage.appendChild(bar);
  }

  Yg.views.coverage = function (stage, route, data, ctx) {
    renderBar(stage, data, ctx);
    renderExport(stage, data);
    renderWorklist(stage, data, ctx);
  };
})();
