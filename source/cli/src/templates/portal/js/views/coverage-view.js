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

  function renderWorklist(stage, data, ctx) {
    var nav = ctx && ctx.navigate ? ctx.navigate : function () {};
    var worklist = data.worklist || [];

    var title = dom.el('div', 'cov-section');
    title.appendChild(dom.el('span', null, 'Needs attention'));
    title.appendChild(dom.el('span', 'cov-section-count', '(' + worklist.length + ')'));
    var jump = dom.el('button', 'cov-jump');
    jump.type = 'button';
    if (worklist.length > 0) {
      jump.textContent = 'Jump to next unresolved →';
      jump.addEventListener('click', function () {
        var first = worklist[0];
        if (first && first.nodes && first.nodes[0]) nav({ view: 'tree', node: first.nodes[0] });
      });
    } else {
      jump.textContent = 'All clear — view the residue →';
      jump.classList.add('cov-jump-residue');
      jump.addEventListener('click', function () {
        nav({ view: 'suppressions' });
      });
    }
    title.appendChild(jump);
    stage.appendChild(title);

    if (worklist.length === 0) {
      var calm = dom.el('div', 'cov-calm');
      calm.appendChild(dom.el('p', null, 'No refusals and nothing unverified on current inputs. Absence of red is not a pass — the residue above (no-rule nodes, unmapped files, waivers) is still worth a look.'));
      stage.appendChild(calm);
      return;
    }

    var card = dom.el('div', 'cov-card');
    for (var i = 0; i < worklist.length; i += 1) {
      card.appendChild(worklistRow(worklist[i], nav));
    }
    stage.appendChild(card);
  }

  function worklistRow(group, nav) {
    var sevState = group.severity === 'error' ? (group.rule === 'unverified' ? 'unverified' : 'refused') : 'warning';
    var row = dom.el('div', 'cov-worow');
    var pill = dom.el('span', 'cov-pill ' + Yg.states.cssClass(sevState));
    pill.appendChild(Yg.states.badge(sevState));
    pill.appendChild(dom.el('span', null, group.severity));
    row.appendChild(pill);

    var id = dom.el('span', 'cov-worow-id');
    id.appendChild(dom.el('b', 'mono', group.rule));
    id.appendChild(dom.el('span', 'cov-worow-reason', group.why));
    row.appendChild(id);

    var meta = dom.el('span', 'cov-worow-meta');
    meta.appendChild(dom.el('span', null, group.nodes.length + (group.nodes.length === 1 ? ' node' : ' nodes')));
    var link = dom.el('button', 'cov-deeplink');
    link.type = 'button';
    link.textContent = 'open →';
    link.addEventListener('click', function () {
      if (group.nodes[0]) nav({ view: 'tree', node: group.nodes[0] });
    });
    meta.appendChild(link);
    row.appendChild(meta);

    var ruleHdr = dom.el('button', 'cov-rulehdr');
    ruleHdr.type = 'button';
    ruleHdr.setAttribute('aria-label', 'open rule ' + group.rule);
    ruleHdr.textContent = '› fix: ' + group.fix;
    ruleHdr.addEventListener('click', function () {
      nav({ view: 'rulebook', aspect: group.rule });
    });
    var wrap = dom.el('div', 'cov-worow-wrap');
    wrap.appendChild(row);
    wrap.appendChild(ruleHdr);
    return wrap;
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
