/*
 * Dependency structure — the read-only structural panel (the same analysis `yg structure`
 * reports: dependency tunnels, module groups, change reach), rendered in plain language.
 *
 * HONESTY, on two axes:
 *   - UNKNOWN, never zero — when the live dependency parse could not run (structure.unknown), the
 *     panel renders an explicit UNKNOWN state, NEVER a fabricated empty/zero graph.
 *   - Small-N — below the node-count floor the "average component" reach reading is not
 *     meaningful, so (structure.smallGraph) the raw figure is shown WITHOUT the interpretive
 *     sentence, in a distinct labelled panel — never a blank section that reads as "clean".
 *
 * Plain language only — no "LCA", "SCC", "conductance", or "quotient" ever reaches the reader; the
 * span reads as "spans N levels across the tree", a loop as "these groups depend on each other".
 * The edge-universe legend (verbatim) is printed on every render, so the reader always knows what
 * an edge is and that event relations are excluded.
 *
 * Browser globals only — reads the already-resolved PortalData; no network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;
  Yg.views = Yg.views || {};

  // Verbatim edge-universe legend — printed on every structure render, no matter the graph.
  var EDGE_UNIVERSE_LEGEND =
    'edges = declared structural relations ∪ statically detected dependencies; event relations excluded; weights not computed';

  /** How many group names to list before collapsing the tail into a count. */
  var MAX_GROUP_NAMES = 12;

  /** `1 level` / `N levels`, so a span always reads as words, never a bare number. */
  function levels(span) {
    return span === 1 ? '1 level' : span + ' levels';
  }

  function renderLegend(stage) {
    stage.appendChild(dom.el('p', 'str-legend', EDGE_UNIVERSE_LEGEND));
  }

  /** UNKNOWN degraded state — honest, distinct, never a fabricated clean/zero graph. */
  function renderUnknown(stage) {
    var unk = dom.el('div', 'str-unknown');
    unk.appendChild(Yg.states.badge('unverified'));
    unk.appendChild(dom.el('b', null, 'UNKNOWN — structure could not be computed'));
    unk.appendChild(
      dom.el(
        'p',
        null,
        'The dependency parse could not run, so the structure is unknown. This is not a clean result and ' +
          'not an empty graph. Re-run yg portal once the parse can complete.',
      ),
    );
    stage.appendChild(unk);
  }

  function renderTunnels(stage, tunnels) {
    var sect = dom.el('section', 'str-sect str-tunnels');
    sect.appendChild(dom.el('h3', 'str-h', 'Tunnels — the dependencies that reach farthest across the tree'));
    if (!tunnels.length) {
      sect.appendChild(dom.el('p', 'str-empty', 'No structural dependencies between components yet.'));
      stage.appendChild(sect);
      return;
    }
    var list = dom.el('div', 'str-tunnel-list');
    for (var i = 0; i < tunnels.length; i += 1) {
      var t = tunnels[i];
      var row = dom.el('div', 'str-tunnel');
      row.appendChild(dom.el('span', 'str-edge mono', t.from + ' → ' + t.to));
      var contract = t.viaContract ? 'via a declared contract' : 'no declared contract';
      row.appendChild(dom.el('span', 'str-span', 'spans ' + levels(t.span) + ' across the tree · ' + contract));
      list.appendChild(row);
    }
    sect.appendChild(list);
    stage.appendChild(sect);
  }

  /** Join a sorted group list, collapsing a long tail into a plain count. */
  function groupList(groups) {
    if (groups.length <= MAX_GROUP_NAMES) return groups.join(', ');
    return groups.slice(0, MAX_GROUP_NAMES).join(', ') + ' (+' + (groups.length - MAX_GROUP_NAMES) + ' more)';
  }

  /** Plain-language description of how cross-group dependencies flow (loops vs one-way). */
  function loopPhrase(crossings, loopShare) {
    if (crossings === 0) return 'No dependencies between these groups.';
    if (loopShare <= 0) return 'All dependencies that cross module groups flow one way (no loops).';
    var rounded = Math.round(loopShare * 100);
    var pct = rounded === 0 ? '<1' : String(rounded);
    return (
      pct +
      '% of the dependencies that cross module groups form a loop (these groups depend on each other); ' +
      'the rest flow one way.'
    );
  }

  function renderModules(stage, layers) {
    var sect = dom.el('section', 'str-sect str-modules');
    sect.appendChild(dom.el('h3', 'str-h', 'Module groups — how the groups at each level depend on one another'));
    if (!layers.length) {
      sect.appendChild(dom.el('p', 'str-empty', 'Not enough grouping to show module structure.'));
      stage.appendChild(sect);
      return;
    }
    for (var i = 0; i < layers.length; i += 1) {
      var L = layers[i];
      var block = dom.el('div', 'str-layer');
      block.appendChild(dom.el('div', 'str-layer-h', 'At level ' + L.depth + ' — ' + L.groups.length + ' groups'));
      block.appendChild(dom.el('div', 'str-layer-groups mono', groupList(L.groups)));
      var dep = L.crossings === 1 ? '1 dependency' : L.crossings + ' dependencies';
      block.appendChild(dom.el('div', 'str-layer-cross', dep + ' cross between groups'));
      block.appendChild(dom.el('div', 'str-layer-loop', loopPhrase(L.crossings, L.loopShare)));
      sect.appendChild(block);
    }
    stage.appendChild(sect);
  }

  function renderReach(stage, structure) {
    var sect = dom.el('section', 'str-sect str-reach');
    sect.appendChild(dom.el('h3', 'str-h', 'Change reach — how far a change tends to travel'));
    var pct = Math.round(structure.reachMean * 100);
    if (structure.smallGraph) {
      // Small-N honesty: the raw figure only, in a distinct labelled panel — no "average
      // component" reading generalised from too few components.
      var sn = dom.el('div', 'str-smalln');
      sn.appendChild(dom.el('b', null, pct + '% average forward reach'));
      sn.appendChild(
        dom.el(
          'p',
          null,
          'Too few components to generalise — the raw figure is shown without an "average component" reading.',
        ),
      );
      sect.appendChild(sn);
    } else {
      sect.appendChild(
        dom.el(
          'p',
          'str-reach-cap',
          'From an average component, ' + pct + '% of the system is reachable through dependencies.',
        ),
      );
    }
    stage.appendChild(sect);
  }

  Yg.views.structure = function (stage, route, data, ctx) {
    var structure = data.structure || { unknown: true };

    var head = dom.el('div', 'str-head');
    head.appendChild(dom.el('span', 'cov-livebadge', 'LIVE'));
    head.appendChild(dom.el('span', null, 'recomputed now, never cached · read-only, never gates the build'));
    stage.appendChild(head);

    renderLegend(stage);

    if (structure.unknown) {
      renderUnknown(stage);
      return;
    }

    stage.appendChild(
      dom.el(
        'p',
        'str-summary',
        structure.edgeCount + ' structural dependencies across ' + structure.nodeCount + ' components.',
      ),
    );
    renderTunnels(stage, structure.tunnels || []);
    renderModules(stage, structure.layers || []);
    renderReach(stage, structure);
  };
})();
