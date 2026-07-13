/*
 * View dispatcher — render the current route's view into the center stage.
 *
 * One pure-ish map from a route's `view` to a render function. Phase-3 ships the FOUNDATION:
 * the honest count header + the honest-state legend (rendered on every view, never
 * collapsing any state into a single "green"), the real virtualized node tree, and a
 * faithful per-view scaffold for the §3a surfaces that arrive in Phase 4 — each scaffold is
 * honest about being a foundation, never a fake "all good" screen. Selecting a node routes
 * to it; the tree view also reveals the selection.
 *
 * Browser globals only — reads the already-resolved PortalData; no network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;

  // view id -> human title + one-line purpose (used for the per-view scaffold header).
  var VIEW_INFO = {
    overview: { title: 'Overview', blurb: 'The plain-language verdict and where the repo stands.' },
    coverage: { title: 'Coverage & audit', blurb: 'The full honest ledger — every verdict, every non-pair state.' },
    tree: { title: 'Structure', blurb: 'The component hierarchy, each row carrying its honest state.' },
    relations: { title: 'Relations & boundaries', blurb: 'The allowed-relation matrix, the hubs, and the live boundary.' },
    structure: { title: 'Dependency structure', blurb: 'The farthest-reaching dependencies, module groups, and change reach — in plain language.' },
    rulebook: { title: 'Rulebook', blurb: 'Every rule the code must satisfy, with its honest tally.' },
    types: { title: 'Type model', blurb: 'The architecture vocabulary — what can be enforced, and how.' },
    flows: { title: 'Flows', blurb: 'The business processes that span components.' },
    suppressions: { title: 'Suppressions', blurb: 'Every deliberate waiver, risk-first.' },
    start: { title: 'Start here', blurb: 'A short guided walk from the committed graph.' },
  };

  /** Render the count header — every honest state shown distinctly, never one "green". */
  function renderCounts(data) {
    var c = data.meta.counts;
    var header = dom.el('header', 'stage-header');
    header.appendChild(dom.el('h1', 'stage-title', data.meta.projectName));
    var sub = dom.el('p', 'stage-sub');
    sub.appendChild(Yg.glossary.term('aspect', c.aspects + ' aspects'));
    sub.appendChild(document.createTextNode(' · ' + c.nodes + ' nodes · ' + c.flows + ' flows · generated ' + data.meta.generatedAt));
    header.appendChild(sub);

    var bar = dom.el('div', 'count-bar');
    var segs = [
      { state: 'verified', value: c.verified },
      { state: 'refused', value: c.refused },
      { state: 'unverified', value: c.unverified },
      { state: 'no-rule', value: c.noRule },
      { state: 'warning', value: c.warnings },
      { state: 'suppressed', value: c.suppressed },
      { state: 'draft', value: c.draft },
    ];
    for (var i = 0; i < segs.length; i += 1) {
      bar.appendChild(countChip(segs[i].state, segs[i].value));
    }
    header.appendChild(bar);
    return header;
  }

  function countChip(state, value) {
    var chip = dom.el('span', 'count-chip ' + Yg.states.cssClass(state));
    chip.appendChild(Yg.states.badge(state));
    chip.appendChild(dom.el('span', 'chip-count', String(value)));
    var labelNode = Yg.glossary.term(state, Yg.states.label(state));
    labelNode.classList.add('chip-label');
    chip.appendChild(labelNode);
    return chip;
  }

  /**
   * The honest key as ONE compact, collapsible bar pinned to the bottom of the viewport — built
   * ONCE by the shell, never re-rendered inside a view's scrolling stage. Collapsed it is a single
   * row of state glyph+label chips; the toggle expands it to the full plain-language descriptions
   * (the same text as the chips' titles). Every state stays distinct (color + glyph + label) and
   * a11y intact — each badge is role="img" with an aria-label from the shared honest-state model,
   * so the key never collapses any state into one green.
   */
  function buildLegendBar() {
    var bar = dom.el('aside', 'legend legend-bar');
    bar.setAttribute('aria-label', 'The honest key — what each state colour and glyph means');

    var head = dom.el('div', 'legend-bar-head');
    var toggle = dom.el('button', 'legend-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    var caret = dom.el('span', 'legend-caret', '▸');
    toggle.appendChild(caret);
    toggle.appendChild(dom.el('span', 'legend-h', 'The honest key'));
    head.appendChild(toggle);

    // Collapsed chips — one per state, glyph + plain label, the full description as a title.
    var chips = dom.el('div', 'legend-chips');
    for (var i = 0; i < Yg.states.ORDER.length; i += 1) {
      var s = Yg.states.ORDER[i];
      var chip = dom.el('span', 'legend-chip ' + Yg.states.cssClass(s));
      chip.appendChild(Yg.states.badge(s));
      chip.appendChild(dom.el('span', 'legend-chip-l', Yg.states.label(s)));
      chip.setAttribute('title', Yg.states.plain(s));
      chips.appendChild(chip);
    }
    head.appendChild(chips);
    bar.appendChild(head);

    // Expanded detail — the full plain-language descriptions, the same text as the legacy key.
    var grid = dom.el('div', 'legend-grid');
    for (var j = 0; j < Yg.states.ORDER.length; j += 1) {
      var state = Yg.states.ORDER[j];
      var item = dom.el('div', 'legend-item ' + Yg.states.cssClass(state));
      item.appendChild(Yg.states.badge(state));
      var t = dom.el('div', 'legend-text');
      t.appendChild(dom.el('b', null, Yg.states.label(state)));
      t.appendChild(dom.el('span', null, Yg.states.plain(state)));
      item.appendChild(t);
      grid.appendChild(item);
    }
    bar.appendChild(grid);

    toggle.addEventListener('click', function () {
      var open = bar.classList.contains('legend-open');
      if (open) bar.classList.remove('legend-open');
      else bar.classList.add('legend-open');
      toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
      caret.textContent = open ? '▸' : '▾';
    });

    return bar;
  }

  /**
   * Render the view named by `route.view` into `stage`. `onSelect(path)` routes a node to its
   * attestation panel; `navigate(route)` is the general router hop the views wire their §3a
   * transitions through (falls back to onSelect-shaped navigation when absent). Every view gets
   * the honest count header; the body is rendered by the matching Yg.views.<view> module. The
   * shared honest legend is NOT appended here — it lives once, as the pinned collapsible legend
   * bar the shell mounts (buildLegendBar), so it is never re-rendered inside a view's scrolling
   * stage. A view with no registered renderer yet gets an honest scaffold, so a not-yet-built
   * surface is never mistaken for a clean pass.
   */
  function render(stage, route, data, onSelect, navigate) {
    dom.clear(stage);
    stage.appendChild(renderCounts(data));

    // A stale / mistyped hash degraded to overview — say so honestly rather than letting the
    // redirect read as a successful navigation (the router carries the requested-but-unknown token).
    if (route && route.notFound) {
      var nf = dom.el('div', 'stage-notfound');
      nf.appendChild(dom.el('span', null, 'Nothing at “' + route.notFound + '” — showing Overview.'));
      stage.appendChild(nf);
    }

    var view = route.view || 'overview';
    var info = VIEW_INFO[view] || VIEW_INFO.overview;

    var nav =
      navigate ||
      function (r) {
        if (r && r.node && onSelect) onSelect(r.node);
      };

    var intro = dom.el('div', 'stage-intro');
    intro.appendChild(dom.el('h2', 'stage-vtitle', info.title));
    intro.appendChild(dom.el('p', 'stage-vblurb', info.blurb));
    stage.appendChild(intro);

    var body = dom.el('div', 'stage-body');
    stage.appendChild(body);

    var renderer = (Yg.views || {})[view];
    if (typeof renderer === 'function') {
      renderer(body, route, data, { onSelect: onSelect, navigate: nav });
    } else {
      body.appendChild(dom.el('p', 'stage-note', 'This surface is rendered in a later phase. The honest key for every state is in the pinned bar at the bottom of the page.'));
    }
  }

  Yg.dispatch = {
    render: render,
    VIEW_INFO: VIEW_INFO,
    _renderCounts: renderCounts,
    buildLegendBar: buildLegendBar,
  };
})();
